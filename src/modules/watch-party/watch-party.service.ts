import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";
import { RedisRetryHelper } from "../retry/redis-retry.helper.js";

export class CreateRoomDto {
    @ApiProperty({ description: 'Explicit 6-character room tracking sequence code', example: 'A1B2C3' })
    @IsString()
    @Length(6, 6)
    roomCode!: string;

    @ApiProperty({ description: 'Plain text password constraint challenge signature', example: 'SecurePass123' })
    @IsString()
    passwordPlain!: string;

    @ApiProperty({ description: 'The unique UUID matching the ingested target film entity' })
    @IsUUID() // Explicitly enforce UUID format check if it matches database IDs
    @IsString()
    movieId!: string;

    @ApiProperty({ description: 'Maximum participant threshold allocation', default: 5, required: false })
    @IsOptional()
    @Type(() => Number) // FORCE execution transformation to cast incoming payload elements safely
    @IsInt()
    @Min(1)
    @Max(20)
    maxParticipants?: number;
}

export class JoinRoomDto {
    @ApiProperty({ 
        description: 'Target 6-character room code to match against active sessions', 
        example: 'A1B2C3' 
    })
    @IsString()
    @Length(6, 6)
    roomCode!: string;

    @ApiProperty({ 
        description: 'Plain text password entry to verify against target room authorization', 
        example: 'SecurePass123' 
    })
    @IsString()   
    passwordPlain!: string;
}

@Injectable()
export class WatchPartyService {
    private readonly logger = new Logger(WatchPartyService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly redis: RedisProvider,
        private readonly redisRetryHelper: RedisRetryHelper,
    ) {}

    /**
     * Initializes a watch room session within PostgreSQL with concurrency control,
     * validates constraints, and projects the initial state into Redis.
     * 
     * ### Workflow & Mechanism
     * 1. **Advisory Locking**: Acquires a PostgreSQL session-level advisory transaction lock 
     *    (`pg_advisory_xact_lock`) scoped to the owner ID. This serializes concurrent room 
     *    creation requests, even across multiple backend instances.
     * 2. **Constraint Validation**: 
     *    - Checks if the user already owns an active room (`is_active = true`).
     *    - Automatically cleans up stale memberships linked to inactive rooms.
     *    - Verifies if the user is currently an active participant in any other room.
     * 3. **PostgreSQL Persistence**: Inserts the new room record and registers the owner 
     *    as an active participant with control privileges within a database transaction.
     * 4. **Redis Projection & Compensation (Saga Pattern)**: 
     *    - Initializes the runtime room state in Redis using exponential backoff retry.
     *    - If Redis synchronization fails after the database transaction commits, a compensation 
     *    step runs to clean up the partial Redis key and mark the database records as inactive 
     *    to prevent orphan/zombie rooms.
     * 
     * ### Usage Example
     * ```ts
     * const room = await this.watchPartyService.createRoomSession({
     *     dto: { roomCode: 'ROOM123', passwordPlain: 'secret', movieId: 'movie-uuid' },
     *     ownerId: 'user-uuid-123'
     * });
     * ```
     * 
     * @param p An object containing the room creation payload and owner identifier.
     * @param p.dto Data Transfer Object containing room settings (`roomCode`, `passwordPlain`, `movieId`, `maxParticipants`).
     * @param p.ownerId The unique UUID of the user attempting to create the room.
     * @returns A promise that resolves with the created room's metadata (`roomId`, `roomCode`, `maxParticipants`).
     * @throws {ConflictException} Throws if the user already owns an active room or is participating in another active room.
     * @throws {Error} Throws if database queries fail or if Redis synchronization and its subsequent compensation fail.
     */
    async createRoomSession(p: {dto: CreateRoomDto, ownerId: string}) {
        this.logger.log({
            message: 'Initiating session generation sequence for watch room',
            ownerId: p.ownerId,
            movieId: p.dto.movieId,
        });

        const cleanRoomCode = p.dto.roomCode.trim().toUpperCase();

        // An active room must be terminated through the gateway lifecycle first.
        // The advisory transaction lock serializes room creation for one owner,
        // including requests handled by different backend instances.

        // The case: 'the same owner submits two room-creation requests almost simultaneously.'
        try {
            // Check ownership
            const room = await this.pg.withTransaction(async (transactionClient) => {
                await transactionClient.query(
                    `SELECT pg_advisory_xact_lock(hashtext($1))`,
                    [`watch-room-owner:${p.ownerId}`],
                );

                const existingRoom = await transactionClient.query(`
                    SELECT id, room_code
                    FROM public.rooms
                    WHERE owner_id = $1 AND is_active = true
                    LIMIT 1`,
                    [p.ownerId]
                );

                if (existingRoom.rows.length > 0) {
                    throw new ConflictException(
                        `[watch-party service] You already own an active room (${existingRoom.rows[0].room_code}). 
                        Close it before creating another room.`
                    );
                }

                // Clear stale owner memberships only when their old room is inactive.

                // This repairs the partial unique membership index after interrupted cleanup.
                // COALESCE() returns the first non-null value in all the parameterized values 
                // in COALESCE(value1, value2, ..., valueN), only return null when there is no 
                // meaning value found
                await transactionClient.query(`
                    UPDATE public.room_participants AS rp
                    SET is_active = false,
                        left_at = COALESCE(rp.left_at, NOW())
                    FROM public.rooms AS r
                    WHERE rp.room_id = r.id
                        AND rp.user_id = $1
                        AND rp.is_active = true
                        AND r.is_active = false`,
                [p.ownerId]);

                // Check for membership
                const activeMembership = await transactionClient.query(`
                    SELECT r.room_code
                    FROM public.room_participants rp
                    INNER JOIN public.rooms r ON r.id = rp.room_id
                    WHERE rp.user_id = $1
                        AND r.is_active =  true
                        AND rp.is_active = true
                    LIMIT 1`, 
                [p.ownerId]);

                if (activeMembership.rows.length > 0) {
                    throw new ConflictException(
                        `[watch-party service] You are already participating in 
                        active room ${activeMembership.rows[0].room_code}. Leave that room 
                        before creating another one.`
                    );
                }

                // After verifying and cleaning up this user stale memberships 
                // (owner-ship and participant-ship)
                // Now this time is for create the room
                const insertRoomQuery = `
                    INSERT INTO public.rooms (
                        room_code,
                        "password",
                        owner_id,
                        movie_id,
                        max_participants,
                        is_active
                    )
                    VALUES ($1, $2, $3, $4, $5, true)
                    RETURNING
                        id, room_code, owner_id, movie_id, max_participants`;
                
                const result = await transactionClient.query<any>(insertRoomQuery, [
                    cleanRoomCode,
                    p.dto.passwordPlain,
                    p. ownerId,
                    p.dto.movieId,
                    p.dto.maxParticipants || 5,
                ]);

                const createdRoom = result.rows[0];

                const createOwnerParticipantQuery = `
                    INSERT INTO public.room_participants (
                        room_id,
                        user_id, 
                        has_control_privilege
                    )
                    VALUES ($1, $2, true)`;
                
                await transactionClient.query(createOwnerParticipantQuery, [
                    createdRoom.id, p.ownerId
                ]);

                return createdRoom;
            });

            /**
             * PostgreSQL transaction has successfully committed here
             * Redis is now initialized as the runtime projection.
             */
            try {
                await this.redisRetryHelper.retry<void>(
                    async () => {
                        await this.redis.setRoomState(room.room_code, {
                            roomId: room.id,
                            roomCode: room.room_code,
                            ownerId: room.owner_id,
                            movieId: room.movie_id,
                            maxParticipants: room.max_participants,
                            participantCount: 1,
                            status: 'PAUSED',
                            playhead: 0,
                            lastUpdated: Date.now(),
                        });
                    },
                    3, 
                    200,
                )
            } catch (redisError) {
                // PostgreSQL and Redis cannot share a transaction. Compensate the 
                // committed DB write so a failed create does not leave an active room.
                try {
                    await this.redisRetryHelper.retry(
                        async () => {
                            await this.redis.delRoomState(room.room_code);
                        }
                    );
                } catch (cacheCleanupError) {
                    this.logger.error({
                        message: 'Failed to remove partial Redis state after room creation failed',
                        roomCode: room.room_code,
                        error: (cacheCleanupError as Error).message,
                    });
                }


                // Room Creation and Membership Record Compensation
                // Inactive the DB write of the failed create
                try {
                    await this.pg.withTransaction(async (transactionClient) => {
                        await transactionClient.query(`
                            UPDATE public.room_participants
                            SET is_active = false, left_at = NOW()
                            WHERE room_id = $1
                            AND is_active = true`,
                            [
                                room.id
                            ]
                        );

                        await transactionClient.query(
                            `UPDATE public.rooms
                            SET is_active = false
                            WHERE id = $1`,
                            [
                                room.id
                            ]
                        );
                    });
                } catch (compensationError) {
                    this.logger.error({
                        message: 'Failed to compensate room creation after Redis initialization failed',
                        roomId: room.id,
                        error: (compensationError as Error).message,
                    });
                }

                throw redisError;
            }

            this.logger.log({
                message: 'Room session metadata committed to PostgreSQL and initialized in Redis',
                roomId: room.id,
                roomCode: room.room_code,
            });

            return {
                roomId: room.id,
                roomCode: room.room_code,
                maxParticipants: room.max_participants,
            };
        } catch (error) {
            this.logger.error(
                {
                    message: 'Failed transaction execution while creating room session',
                    ownerId: p.ownerId,
                    error: (error as Error).message,
                },
                (error as Error).stack,
            );

            throw error;
        }
    }

    /**
     * Associates a user as an active participant in a watch room session, enforcing 
     * room credentials, capacity limits, and mutual exclusivity across active rooms.
     * 
     * ### Workflow & Mechanism
     * 1. **Row-Level Locking**: Queries and locks the target room row (`FOR UPDATE`) using 
     *    the normalized room code to prevent concurrent joins from observing stale capacity.
     * 2. **Security Verification**: Validates the room's password (unless the user is the room owner).
     * 3. **Single-Room Enforcement**: Verifies that the user is not actively participating in 
     *    any other active room (`r.is_active = true` and `rp.is_active = true`).
     * 4. **Membership Handling**:
     *    - **Reuse**: If the user already has an active participant record in this room, it reuses it.
     *    - **Insertion**: If no active membership exists, checks the current active participant 
     *      count against `max_participants`. If capacity allows, creates a new participant record.
     * 5. **Redis Synchronization & Compensation (Saga Pattern)**:
     *    - Updates Redis with the new participant count using an exponential backoff retry.
     *    - If Redis updates fail after the database transaction commits, a compensation step 
     *      runs to deactivate the newly created participant record, keeping data consistent.
     * 
     * ### Usage Example
     * ```ts
     * const association = await this.watchPartyService.associateParticipant({
     *     dto: { roomCode: 'ROOM123', passwordPlain: 'secret' },
     *     userId: 'user-uuid-456'
     * });
     * ```
     * 
     * @param p An object containing the join details and user identifier.
     * @param p.dto Data Transfer Object containing the room code and password.
     * @param p.userId The unique UUID of the user attempting to join the room.
     * @returns A promise resolving with participant metadata, including `participantId`, `createdMembership`, and updated `participantCount`.
     * @throws {NotFoundException} Throws if no matching active room is found.
     * @throws {BadRequestException} Throws if credentials are invalid or the room has reached maximum capacity.
     * @throws {ConflictException} Throws if the user is already participating in another active room.
     * @throws {Error} Throws if database operations fail or if Redis synchronization and its subsequent compensation fail.
     */
    async associateParticipant(p: {dto: JoinRoomDto, userId: string}) {
        const cleanCode = p.dto.roomCode.trim().toUpperCase();

        try {
            const result = await this.pg.withTransaction(
                async (transactionClient) => {
                    /*
                     * Lock the room row so two concurrent joins cannot both
                     * observe the same available capacity.
                     */
                    const roomResult = await transactionClient.query<any>(
                        `
                        SELECT
                            id,
                            room_code,
                            "password",
                            owner_id,
                            movie_id,
                            max_participants
                        FROM public.rooms
                        WHERE UPPER(TRIM(room_code)) = $1
                        AND is_active = true
                        FOR UPDATE
                        `,
                        [cleanCode],
                    );

                    if (roomResult.rows.length === 0) {
                        this.logger.warn({
                            message: 'Join room rejected: Active room not found',
                            roomCode: cleanCode,
                            userId: p.userId,
                        });

                        throw new NotFoundException(
                            'Handshake rejected: No matching active room stream code sequence.',
                        );
                    }

                    const room = roomResult.rows[0];

                    /*
                     * First determine whether this user already has an
                     * ACTIVE participant record in this room.
                     *
                     * If yes, that record is reused.
                     */
                    const existingParticipantResult =  await transactionClient.query<any>(
                        `
                        SELECT
                            id,
                            room_id,
                            user_id,
                            has_control_privilege
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND user_id = $2
                        AND is_active = true
                        LIMIT 1
                        `,
                        [
                            room.id,
                            p.userId,
                        ],
                    );

                    const existingParticipant = existingParticipantResult.rows[0];

                    const isOwner = p.userId === room.owner_id;

                    if ( !isOwner && room.password !== p.dto.passwordPlain) {
                        this.logger.warn({
                            message: 'Join room rejected: Invalid room credentials',
                            roomCode: cleanCode,
                            roomId: room.id,
                            userId: p.userId,
                        });

                        throw new BadRequestException(
                            'Security credentials verification failure: Authentication rejected.',
                        );
                    }

                    /*
                     * A user cannot simultaneously belong to another
                     * active room.
                     */
                    const existingOtherRoomResult = await transactionClient.query<any>(
                        `
                        SELECT
                            rp.room_id,
                            r.room_code
                        FROM public.room_participants rp
                        INNER JOIN public.rooms r
                            ON r.id = rp.room_id
                        WHERE rp.user_id = $1
                        AND rp.is_active = true
                        AND r.is_active = true
                        AND r.id <> $2
                        LIMIT 1
                        `,
                        [
                            p.userId,
                            room.id,
                        ],
                    );

                    if (existingOtherRoomResult.rows.length > 0) {
                        const otherRoom = existingOtherRoomResult.rows[0];

                        throw new ConflictException(
                            `You are already participating in room ${otherRoom.room_code}. Leave that room before joining another one.`,
                        );
                    }

                    let participant;
                    let createdMembership = false;

                    if (existingParticipant) {
                        /*
                         * Active record exists.
                         * Reuse it.
                         * Do NOT INSERT another row.
                         */
                        participant = existingParticipant;

                        this.logger.log({
                            message: 'Existing active room participant reused',
                            roomId: room.id,
                            userId: p.userId,
                            participantId: participant.id,
                            hasControlPrivilege: participant.has_control_privilege,
                            isOwner,
                        });
                    } else {
                        /*
                         * No active membership exists.
                         *
                         * An old inactive row may exist, but that is historical.
                         * This join receives a NEW participant record.
                         */
                        const countResult =  await transactionClient.query<any>(
                            `
                            SELECT COUNT(*)::int AS count
                            FROM public.room_participants
                            WHERE room_id = $1
                            AND is_active = true
                            `,
                            [room.id],
                        );

                        const participantCount = countResult.rows[0].count;

                        if (participantCount >= room.max_participants) {
                            throw new BadRequestException(
                                `Room capacity overflow limit reached. Cap: ${room.max_participants}`,
                            );
                        }

                        const participantResult = await transactionClient.query<any>(
                            `
                            INSERT INTO public.room_participants (
                                room_id,
                                user_id
                            )
                            VALUES ($1, $2)
                            RETURNING
                                id,
                                room_id,
                                user_id,
                                has_control_privilege
                            `,
                            [
                                room.id,
                                p.userId,
                            ],
                        );

                        participant = participantResult.rows[0];
                        createdMembership = true;

                        this.logger.log({
                            message: 'New room participant record created',
                            roomId: room.id,
                            userId: p.userId,
                            participantId: participant.id,
                            isOwner,
                        });
                    }

                    /*
                     * Get authoritative active occupancy after either
                     * reuse or insertion.
                     */
                    const finalCountResult = await transactionClient.query<any>(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                        [room.id],
                    );

                    const participantCount = finalCountResult.rows[0].count;

                    return {
                        participantId: participant.id,
                        createdMembership,
                        roomId: room.id,
                        roomCode: room.room_code,
                        passwordPlain: room.password,
                        movieId: room.movie_id,
                        ownerId: room.owner_id,
                        maxParticipants: room.max_participants,
                        participantCount,
                    };
                },
            );

            /*
             * PostgreSQL membership transaction has committed.
             * Now update Redis's ephemeral room projection.
             */
            try {
                await this.redisRetryHelper.retry(
                    async () => {
                        await this.redis.updateRoomState(
                            result.roomCode,
                            {
                                participantCount: result.participantCount,
                            },
                        );
                    }
                );
            } catch (redisError) {
                this.logger.error({
                    message: 'Failed to update Redis after participant association',
                    participantId: result.participantId,
                    roomId: result.roomId,
                    createdMembership: result.createdMembership,
                    error: (redisError as Error).message,
                });

                if (result.createdMembership) {
                    try {
                        await this.pg.withTransaction(async (transactionClient) => {
                            await transactionClient.query(`
                                UPDATE public.room_participants
                                SET is_active = false,
                                    left_at = NOW()
                                WHERE id = $1 AND is_active = true`,
                            [
                                result.participantId
                            ]);
                        });
                    } catch (compensationError) {
                        this.logger.error({
                            message: 'Failed to compensate new membership after Redis update failure',
                            participantId: result.participantId,
                            roomId: result.roomId,
                            error: (compensationError as Error).message,
                        });
                    }
                }

                throw redisError;
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Failed room participant association',
                roomCode: cleanCode,
                userId: p.userId,
                error: (error as Error).message,
            });

            throw error;
        }
    }

    async disassociateParticipant(participantId: string): Promise<{
        roomId: string;
        roomCode: string;
        participantCount: number;
    }> {
        try {
            const result = await this.pg.withTransaction(
                async (transactionClient) => {
                    /*
                     * Find the active participant and lock its room.
                     */
                    const participantResult = await transactionClient.query<any>(
                        `
                        SELECT
                            rp.id,
                            rp.room_id,
                            r.room_code
                        FROM public.room_participants rp
                        INNER JOIN public.rooms r
                            ON r.id = rp.room_id
                        WHERE rp.id = $1
                        AND rp.is_active = true
                        FOR UPDATE OF rp
                        `,
                        [participantId],
                    );

                    if (participantResult.rows.length === 0) {
                        return null;
                    }

                    const participant =participantResult.rows[0];

                    await transactionClient.query(
                        `
                        UPDATE public.room_participants
                        SET is_active = false,
                            left_at = NOW()
                        WHERE id = $1
                        AND is_active = true
                        `,
                        [participantId],
                    );

                    const countResult = await transactionClient.query<any>(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                        [participant.room_id],
                    );

                    return {
                        roomId: participant.room_id,
                        roomCode: participant.room_code,
                        participantCount: countResult.rows[0].count,
                    };
                },
            );

            if (!result) {
                this.logger.warn({
                    message: 'No active membership was deactivated',
                    participantId,
                });

                throw new NotFoundException(
                    'Active room participant membership was not found.',
                );
            }

            await this.redisRetryHelper.retry(
                async () => {
                    await this.redis.updateRoomState(
                        result.roomCode,
                        {
                            participantCount: result.participantCount,
                        },
                    );
                }
            );

            this.logger.log({
                message: 'Participant membership deactivated without deleting history',
                participantId,
                roomId: result.roomId,
                participantCount: result.participantCount,
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Failed to deactivate room participant membership',
                participantId,
                error: (error as Error).message,
            });

            throw error;
        }
    }

    /**
     * Disassociates a user from a watch room session by deactivating their participant 
     * record, recalculating the active occupancy count, and synchronizing the state with Redis.
     * 
     * ### Workflow & Mechanism
     * 1. **Active Membership Lookup & Row Locking**: Queries the active participant record 
     *    and joins the rooms table, locking the target participant row (`FOR UPDATE OF rp`) 
     *    to serialize concurrent leave or cleanup operations.
     * 2. **State Deactivation**: Updates the participant's record by setting `is_active = false` 
     *    and recording the departure timestamp (`left_at = NOW()`), preserving historical data.
     * 3. **Occupancy Recalculation**: Counts the remaining active participants in the room 
     *    within the same transaction boundary to ensure a consistent count.
     * 4. **Redis Projection Update**: Synchronizes the updated lower participant count 
     *    to Redis. If no active membership is found, logs a warning and throws a `NotFoundException`.
     * 
     * ### Usage Example
     * ```ts
     * const roomState = await this.watchPartyService.disassociateParticipant('participant-uuid-789');
     * ```
     * 
     * @param participantId The unique UUID of the room participant record to deactivate.
     * @returns A promise resolving with the updated room metadata (`roomId`, `roomCode`, and new `participantCount`).
     * @throws {NotFoundException} Throws if no active membership record is found for the given participant ID.
     * @throws {Error} Throws if database operations or Redis synchronization fail.
     */
    async leaveRoomSession(userId: string, roomId?: string): Promise<{ 
        status: string;
        roomCode?: string;
        roomId?: string;
        membersToKick?: string[];
        participantCount?: number;
    }> {
        const result = await this.pg.withTransaction(
            async (transactionClient) => {
                const userSessionResult = await transactionClient.query<any>(
                    `
                    SELECT
                        r.id AS room_id,
                        r.room_code,
                        r.owner_id,
                        rp.id AS participant_id
                    FROM public.rooms r
                    LEFT JOIN public.room_participants rp
                        ON r.id = rp.room_id
                        AND rp.user_id = $1
                        AND rp.is_active = true
                    WHERE (
                        r.owner_id = $1
                        OR rp.user_id = $1
                    )
                    AND r.is_active = true
                    AND ($2::uuid IS NULL OR r.id = $2::uuid)
                    FOR UPDATE OF r
                    `,
                    [userId, roomId ?? null],
                );

                if (userSessionResult.rows.length === 0) {
                    // An earlier cleanup attempt may have deactivated the room
                    // in PostgreSQL but failed while deleting its Redis projection.
                    // Return the exact inactive owner room so a retry can finish cleanup
                    if (roomId) {
                        const inactiveRoomResult = await transactionClient.query<any>(`
                            SELECT id AS room_id, room_code, owner_id, is_active
                            FROM public.rooms
                            WHERE id = $1
                            LIMIT 1`,
                        [
                            roomId
                        ]);

                        const inactiveRoom = inactiveRoomResult.rows[0];

                        if (inactiveRoom && 
                            inactiveRoom.owner_id === userId &&
                            inactiveRoom.is_active === false
                        ) {
                            return {
                                status: 'ROOM_ALREADY_INACTIVE',
                                roomCode: inactiveRoom.room_code,
                                roomId: inactiveRoom.room_id,
                                participantCount: 0,
                            }
                        }
                    }

                    return {
                        status: 'NO_ACTIVE_SESSION',
                    };
                }

                const session = userSessionResult.rows[0];

                const {
                    room_id,
                    room_code,
                    owner_id,
                } = session;

                if (owner_id === userId) {
                    this.logger.log({
                        message: 'Owner disconnected. Cleaning up room engine entirely.',
                        roomCode: room_code,
                        ownerId: userId,
                    });

                    const membersResult = await transactionClient.query<any>(
                        `
                        SELECT user_id
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                        [room_id],
                    );

                    const membersToKick = membersResult.rows.map(
                        (member: any) => member.user_id,
                    );

                    await transactionClient.query(
                        `
                        UPDATE public.rooms
                        SET is_active = false
                        WHERE id = $1
                        `,
                        [room_id],
                    );

                    await transactionClient.query(
                        `
                        UPDATE public.room_participants
                        SET is_active = false,
                            left_at = NOW()
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                        [room_id],
                    );

                    return {
                        status: 'ROOM_DESTROYED',
                        roomCode: room_code,
                        roomId: room_id,
                        membersToKick,
                        participantCount: 0,
                    };
                }

                this.logger.log({
                    message: 'Participant disconnected. Removing from tracking relation.',
                    roomCode: room_code,
                    userId,
                });

                await transactionClient.query(
                    `
                    UPDATE public.room_participants
                    SET is_active = false,
                        left_at = NOW()
                    WHERE room_id = $1
                    AND user_id = $2
                    AND is_active = true
                    `,
                    [
                        room_id,
                        userId,
                    ],
                );

                const countResult = await transactionClient.query<any>(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM public.room_participants
                    WHERE room_id = $1
                    AND is_active = true
                    `,
                    [room_id],
                );

                return {
                    status: 'PARTICIPANT_EVICTED',
                    roomCode: room_code,
                    roomId: room_id,
                    participantCount:
                        countResult.rows[0].count,
                };
            },
        );

        if (result.status === 'NO_ACTIVE_SESSION') {
            return result;
        }

        if (result.status === 'ROOM_DESTROYED' ||
            result.status === 'ROOM_ALREADY_INACTIVE'
        ) {
            await this.redisRetryHelper.retry(
                async () => {
                    await this.redis.delRoomState(
                        result.roomCode!,
                    );
                }
            );

            return result;
        }

        await this.redisRetryHelper.retry(
            async () => {
                await this.redis.updateRoomState(
                    result.roomCode!,
                    {
                        participantCount: result.participantCount!,
                    },
                );
            }
        );

        return result;
    }

    /**
     * Fetches active room details from PostgreSQL by its room code, with automatic 
     * sanitization, normalization, and handling for missing or inactive rooms.
     * 
     * ### Workflow & Mechanism
     * 1. **Sanitization & Normalization**: Trims whitespace and converts the input `roomCode` 
     *    to uppercase to ensure consistent matching against database records.
     * 2. **Database Lookup**: Queries the `public.rooms` table for an active record (`is_active = true`) 
     *    matching the normalized code, mapping columns to camelCase aliases (`roomId`, `roomCode`, etc.).
     * 3. **Result Handling**: 
     *    - If no matching active room is found, logs a warning and returns `null`.
     *    - If found, returns the mapped room details object from the first row.
     * 
     * ### Usage Example
     * ```ts
     * const room = await this.watchPartyService.getRoomDetailsByCode('ROOM123');
     * if (!room) {
     *     // Handle room not found
     * }
     * ```
     * 
     * @param roomCode The unique string code of the watch room to look up.
     * @returns A promise resolving with the room details object, or `null` if the room is not found or inactive.
     * @throws {Error} Throws if the database query execution fails unexpectedly.
     */
    async getRoomDetailsByCode(roomCode: string) {
        const query = `
            SELECT 
                id AS "roomId",
                room_code AS "roomCode",
                owner_id AS "ownerId",
                movie_id AS "movieId",
                max_participants AS "maxParticipants",
                is_active AS "isActive"
            FROM public.rooms
            WHERE UPPER(TRIM(room_code)) = $1
            AND is_active = true
        `;

        try {
            const cleanCode = roomCode.trim().toUpperCase();

            const result = await this.pg.query<any>(
                query,
                [cleanCode],
            );

            if (result.rows.length === 0) {
                this.logger.warn({
                    message: 'Room lookup failed: Code not found or inactive',
                    roomCode,
                });

                return null;
            }

            return result.rows[0];
        } catch (error) {
            this.logger.error({
                message: 'Failed to execute room database lookup query',
                roomCode,
                error: (error as Error).message,
            });

            throw error;
        }
    }
}