import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";

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
    @ApiProperty({ description: 'Target 6-character room code to match against active sessions', example: 'A1B2C3' })
    roomCode!: string;

    @ApiProperty({ description: 'Plain text password entry to verify against target room authorization', example: 'SecurePass123' })
    passwordPlain!: string;
}

@Injectable()
export class WatchPartyService {
    private readonly logger = new Logger(WatchPartyService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly redis: RedisProvider,
    ) {}

    /** 
     * Initializes watch room settings within PostgreSQL using explicit DDL keys
     */
    async createRoomSession(p: {dto: CreateRoomDto, ownerId: string}) {
        this.logger.log({
            message: 'Initiating session generation sequence for watch room',
            ownerId: p.ownerId,
            movieId: p.dto.movieId,
        });

        // 1. Check if an active allocation exists for this user
        const activeCheckQuery = `
            SELECT id, room_code
            FROM public.rooms
            WHERE owner_id = $1
            AND is_active = true
        `;

        const existingRoom = await this.pg.query<any>(activeCheckQuery, [p.ownerId]);

        if (existingRoom.rows.length > 0) {
            const staleRoom = existingRoom.rows[0];

            this.logger.warn({ 
                message: 'Overriding stale room session allocation detected during new creation request', 
                ownerId: p.ownerId, 
                staleRoomId: staleRoom.id,
                staleRoomCode: staleRoom.room_code
            });

            // 2. FORWARD-CLEANUP: make as inactive
            await this.pg.withTransaction(async (transactionClient) => {
                await transactionClient.query(
                    `
                    UPDATE public.rooms
                    SET is_active = false
                    WHERE id = $1
                    `,
                    [staleRoom.id],
                );

                await transactionClient.query(
                    `
                    UPDATE public.room_participants
                    SET is_active = false,
                        left_at = NOW()
                    WHERE room_id = $1
                    AND is_active = true
                    `,
                    [existingRoom.rows[0].id],
                );
            });
            
            // Wipe cache layer synchronously
            await this.redis.delRoomState(staleRoom.room_code);
        }

        try {
            const room =  await this.pg.withTransaction(async (transactionClient) => {
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
                        id,
                        room_code,
                        owner_id,
                        movie_id,
                        max_participants
                `;

                const roomResult = await transactionClient.query<any>(
                    insertRoomQuery, 
                    [
                        p.dto.roomCode,
                        p.dto.passwordPlain,   
                        p.ownerId,
                        p.dto.movieId,
                        p.dto.maxParticipants || 5
                    ]
                );

                const createdRoom  = roomResult.rows[0];

                const createOwnerParticipantQuery = `
                    INSERT INTO public.room_participants (
                        room_id,
                        user_id,
                        has_control_privilege
                    )
                    VALUES ($1, $2, true)
                `;

                await transactionClient.query(
                    createOwnerParticipantQuery,
                    [
                        createdRoom.id,
                        p.ownerId,
                    ],
                );

                return createdRoom;

            });

            /*
             * PostgreSQL transaction has successfully committed here.
             * Redis is now initialized as the runtime projection.
             */
            await this.redis.setRoomState(room.room_code, {
                roomId: room.id,
                roomCode: room.room_code,
                ownerId: room.owner_id,
                movieId: room.movie_id,
                maxParticipants: room.max_participants,
                participantCount: 1,
                status: 'PAUSED',
                playhead: 0,
                lastUpdated: Date.now()
            });
            
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
     * 
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
            await this.redis.updateRoomState(
                result.roomCode,
                {
                    participantCount: result.participantCount,
                },
            );

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

            await this.redis.updateRoomState(
                result.roomCode,
                {
                    participantCount: result.participantCount,
                },
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

    async leaveRoomSession(userId: string): Promise<{ 
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
                    FOR UPDATE OF r
                    `,
                    [userId],
                );

                if (userSessionResult.rows.length === 0) {
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

        if (result.status === 'ROOM_DESTROYED') {
            await this.redis.delRoomState(
                result.roomCode!,
            );

            return result;
        }

        await this.redis.updateRoomState(
            result.roomCode!,
            {
                participantCount: result.participantCount!,
            },
        );

        return result;
    }

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