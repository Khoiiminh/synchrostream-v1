import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Length,
    Matches,
    Max,
    Min,
} from "class-validator";
import type { PoolClient } from "pg";
import { randomInt } from "node:crypto";
import { RoomLifecycleOutboxService } from "./room-lifecycle-outbox.service.js";
import type {
    ActiveMembershipRow,
    CountRow,
    CreatedRoomRow,
    InactiveRoomRow,
    LockedRoomRow,
    MemberUserRow,
    ParticipantRow,
    RoomDetails,
    RoomProjectionRow,
    RoomStatusRow,
    StateVersionRow,
    UserSessionRow,
} from "./watch-party.rows.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_GENERATION_ATTEMPTS = 5;

function generateRoomCode(): string {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    return code;
}

export class CreateRoomDto {
    @ApiProperty({
        description:
            "Optional explicit 6-character room code. Omit it to let the server generate a unique code.",
        example: "A1B2C3",
        required: false,
    })
    @IsOptional()
    @IsString()
    @Length(6, 6)
    @Matches(/^[A-Za-z0-9]{6}$/)
    roomCode?: string;

    @ApiProperty({
        description: "Plain text password constraint challenge signature",
        example: "SecurePass123",
    })
    @IsString()
    passwordPlain!: string;

    @ApiProperty({
        description: "The unique UUID matching the ingested target film entity",
    })
    @IsUUID() // Explicitly enforce UUID format check if it matches database IDs
    @IsString()
    movieId!: string;

    @ApiProperty({
        description:
            "Leave the room the caller is currently in (closing it if they own it) and then create this one. Sent after the user confirms the ACTIVE_OWNER_ROOM / ACTIVE_MEMBERSHIP_ELSEWHERE conflict.",
        required: false,
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    leaveCurrent?: boolean;

    @ApiProperty({
        description: "Maximum participant threshold allocation",
        default: 5,
        required: false,
    })
    @IsOptional()
    @Type(() => Number) // FORCE execution transformation to cast incoming payload elements safely
    @IsInt()
    @Min(1)
    @Max(20)
    maxParticipants?: number;
}

export class JoinRoomDto {
    @ApiProperty({
        description:
            "Target 6-character room code to match against active sessions",
        example: "A1B2C3",
    })
    @IsString()
    @Length(6, 6)
    roomCode!: string;

    @ApiProperty({
        description:
            "Plain text password entry to verify against target room authorization",
        example: "SecurePass123",
    })
    @IsString()
    passwordPlain!: string;
}

@Injectable()
export class WatchPartyService {
    private readonly logger = new Logger(WatchPartyService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly lifecycleOutbox: RoomLifecycleOutboxService,
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
    async createRoomSession(p: { dto: CreateRoomDto; ownerId: string }) {
        this.logger.debug({
            message: "Initiating session generation sequence for watch room",
            ownerId: p.ownerId,
            movieId: p.dto.movieId,
        });

        const requestedRoomCode = p.dto.roomCode?.trim().toUpperCase();

        // An active room must be terminated through the gateway lifecycle first.
        // The advisory transaction lock serializes room creation for one owner,
        // including requests handled by different backend instances.

        // The case: 'the same owner submits two room-creation requests almost simultaneously.'
        for (let codeAttempt = 0; ; codeAttempt += 1) {
            // Server-generated codes are retried on collision with a reserved code.
            const cleanRoomCode = requestedRoomCode ?? generateRoomCode();
            try {
                // Check ownership
                const room = await this.pg.withTransaction(
                    async (transactionClient) => {
                        await transactionClient.query(
                            `SELECT pg_advisory_xact_lock(hashtext($1))`,
                            [`watch-room-owner:${p.ownerId}`],
                        );

                        // A TERMINATING room can never become available again, so it does
                        // not block a new room; it keeps only its code reserved while the
                        // outbox finishes provider and projection cleanup.
                        const existingRoom = await transactionClient.query<{
                            id: string;
                            room_code: string;
                        }>(
                            `
                    SELECT id, room_code
                    FROM public.rooms
                    WHERE owner_id = $1 AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                    LIMIT 1`,
                            [p.ownerId],
                        );

                        if (existingRoom.rows.length > 0) {
                            throw new ConflictException({
                                message: `You already have an active room (${existingRoom.rows[0].room_code}). Close it before creating another room.`,
                                error: {
                                    code: "ACTIVE_OWNER_ROOM",
                                    roomId: existingRoom.rows[0].id,
                                    roomCode: existingRoom.rows[0].room_code,
                                    isOwner: true,
                                },
                            });
                        }

                        // Clear memberships only after their owning room has fully terminated.
                        await transactionClient.query(
                            `
                    UPDATE public.room_participants AS rp
                    SET is_active = false,
                        left_at = COALESCE(rp.left_at, NOW())
                    FROM public.rooms AS r
                    WHERE rp.room_id = r.id
                        AND rp.user_id = $1
                        AND rp.is_active = true
                        AND r.lifecycle_status = 'TERMINATED'`,
                            [p.ownerId],
                        );

                        // Check for membership in someone else's room.
                        const currentRoom = await this.findCurrentRoom(
                            transactionClient,
                            p.ownerId,
                        );
                        if (currentRoom) {
                            throw this.membershipElsewhereConflict(currentRoom);
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
                        is_active,
                        lifecycle_status,
                        state_version
                    )
                    VALUES ($1, $2, $3, $4, $5, false, 'PROVISIONING', 1)
                    RETURNING
                        id, room_code, owner_id, movie_id, max_participants, state_version`;

                        const result =
                            await transactionClient.query<CreatedRoomRow>(
                                insertRoomQuery,
                                [
                                    cleanRoomCode,
                                    p.dto.passwordPlain,
                                    p.ownerId,
                                    p.dto.movieId,
                                    p.dto.maxParticipants || 5,
                                ],
                            );

                        const createdRoom = result.rows[0];

                        await this.lifecycleOutbox.enqueueRoomReconciliation(
                            transactionClient,
                            createdRoom.id,
                        );

                        const createOwnerParticipantQuery = `
                    INSERT INTO public.room_participants (
                        room_id,
                        user_id, 
                        has_control_privilege
                    )
                    VALUES ($1, $2, true)`;

                        await transactionClient.query(
                            createOwnerParticipantQuery,
                            [createdRoom.id, p.ownerId],
                        );

                        return createdRoom;
                    },
                );

                // The room and its provisioning event are committed. Inline
                // provisioning only makes the healthy path fast; its failure must
                // not be reported as a failed creation, because the outbox will
                // finish the work and the client can wait for ACTIVE.
                let lifecycleStatus: "PROVISIONING" | "ACTIVE" = "PROVISIONING";
                try {
                    await this.lifecycleOutbox.provisionRoomNow(room.id);
                    lifecycleStatus = "ACTIVE";
                } catch (provisioningError) {
                    this.logger.warn({
                        message:
                            "Inline room provisioning failed; the durable outbox will complete it",
                        roomId: room.id,
                        roomCode: room.room_code,
                        err: provisioningError,
                    });
                }

                this.logger.log({
                    message:
                        "Room session and durable provisioning work committed to PostgreSQL",
                    roomId: room.id,
                    roomCode: room.room_code,
                    lifecycleStatus,
                });

                return {
                    roomId: room.id,
                    roomCode: room.room_code,
                    maxParticipants: room.max_participants,
                    lifecycleStatus,
                };
            } catch (error) {
                const pgError = error as { code?: string; constraint?: string };
                if (
                    pgError.code === "23505" &&
                    pgError.constraint === "idx_one_active_room_per_user"
                ) {
                    // A concurrent join committed first; report which room, so the
                    // client can offer to switch.
                    const currentRoom = await this.findCurrentRoom(
                        this.pg,
                        p.ownerId,
                    );
                    throw currentRoom
                        ? this.membershipElsewhereConflict(currentRoom)
                        : new ConflictException(
                              "You already belong to an active watch room.",
                          );
                }
                if (
                    pgError.code === "23505" &&
                    pgError.constraint === "idx_active_room_code"
                ) {
                    if (
                        !requestedRoomCode &&
                        codeAttempt + 1 < ROOM_CODE_GENERATION_ATTEMPTS
                    ) {
                        continue;
                    }
                    throw new ConflictException({
                        message: requestedRoomCode
                            ? `Room code ${requestedRoomCode} is already in use. Choose another code.`
                            : "Could not allocate a unique room code. Please try again.",
                        error: { code: "ROOM_CODE_IN_USE" },
                    });
                }
                this.logger.error({
                    message:
                        "Failed transaction execution while creating room session",
                    ownerId: p.ownerId,
                    err: error,
                });

                throw error;
            }
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
    async associateParticipant(p: { dto: JoinRoomDto; userId: string }) {
        const cleanCode = p.dto.roomCode.trim().toUpperCase();

        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                p.userId,
            )
        ) {
            throw new BadRequestException(
                "An authenticated user UUID is required to join a room.",
            );
        }

        try {
            const result = await this.pg.withTransaction(
                async (transactionClient) => {
                    /*
                     * Lock the room row so two concurrent joins cannot both
                     * observe the same available capacity.
                     */
                    const roomResult =
                        await transactionClient.query<LockedRoomRow>(
                            `
                        SELECT
                            id,
                            room_code,
                            "password",
                            owner_id,
                            movie_id,
                            max_participants,
                            lifecycle_status,
                            state_version
                        FROM public.rooms
                        WHERE UPPER(TRIM(room_code)) = $1
                        AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                        FOR UPDATE
                        `,
                            [cleanCode],
                        );

                    if (
                        roomResult.rows[0]?.lifecycle_status === "PROVISIONING"
                    ) {
                        // Committed but not yet projected/activated by the outbox.
                        // 503 tells the gateway client to retry shortly.
                        throw new ServiceUnavailableException(
                            "The watch room is still being prepared. Retrying shortly.",
                        );
                    }

                    if (roomResult.rows.length === 0) {
                        this.logger.warn({
                            message:
                                "Join room rejected: Active room not found",
                            roomCode: cleanCode,
                            userId: p.userId,
                        });

                        throw new NotFoundException(
                            "Handshake rejected: No matching active room stream code sequence.",
                        );
                    }

                    const room = roomResult.rows[0];

                    /*
                     * First determine whether this user already has an
                     * ACTIVE participant record in this room.
                     *
                     * If yes, that record is reused.
                     */
                    const existingParticipantResult =
                        await transactionClient.query<ParticipantRow>(
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
                            [room.id, p.userId],
                        );

                    const existingParticipant =
                        existingParticipantResult.rows[0];

                    const isOwner = p.userId === room.owner_id;

                    if (!isOwner && room.password !== p.dto.passwordPlain) {
                        this.logger.warn({
                            message:
                                "Join room rejected: Invalid room credentials",
                            roomCode: cleanCode,
                            roomId: room.id,
                            userId: p.userId,
                        });

                        throw new BadRequestException(
                            "Security credentials verification failure: Authentication rejected.",
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
                            message: "Existing active room participant reused",
                            roomId: room.id,
                            userId: p.userId,
                            participantId: participant.id,
                            hasControlPrivilege:
                                participant.has_control_privilege,
                            isOwner,
                        });
                    } else {
                        /*
                         * No active membership exists.
                         *
                         * An old inactive row may exist, but that is historical.
                         * This join receives a NEW participant record.
                         */
                        const countResult =
                            await transactionClient.query<CountRow>(
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

                        /*
                         * A user cannot simultaneously belong to another room.
                         * Checked only after credentials and capacity, so a
                         * client that answers this conflict with "leave the
                         * current room and switch" never leaves its room for a
                         * join that would have failed anyway.
                         */
                        const currentRoom = await this.findCurrentRoom(
                            transactionClient,
                            p.userId,
                            room.id,
                        );
                        if (currentRoom) {
                            throw this.membershipElsewhereConflict(currentRoom);
                        }

                        const participantResult =
                            await transactionClient.query<ParticipantRow>(
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
                                [room.id, p.userId],
                            );

                        participant = participantResult.rows[0];
                        createdMembership = true;

                        this.logger.log({
                            message: "New room participant record created",
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
                    const finalCountResult =
                        await transactionClient.query<CountRow>(
                            `
                        SELECT COUNT(*)::int AS count
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                            [room.id],
                        );

                    const participantCount = finalCountResult.rows[0].count;

                    let stateVersion = room.state_version;
                    if (createdMembership) {
                        const versionResult =
                            await transactionClient.query<StateVersionRow>(
                                `UPDATE public.rooms
                             SET state_version = state_version + 1
                             WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                             RETURNING state_version`,
                                [room.id],
                            );
                        stateVersion = versionResult.rows[0].state_version;
                        await this.lifecycleOutbox.enqueueRoomReconciliation(
                            transactionClient,
                            room.id,
                        );
                    }

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
                        lifecycleVersion: stateVersion,
                    };
                },
            );

            return result;
        } catch (error: unknown) {
            const pgError = error as {
                code?: string;
                constraint?: string;
            };

            if (
                pgError.code === "23505" &&
                pgError.constraint === "idx_one_active_room_per_user"
            ) {
                this.logger.warn({
                    message:
                        "Join rejected: User already has an active room membership",
                    roomCode: cleanCode,
                    userId: p.userId,
                    constraint: pgError.constraint,
                });

                const currentRoom = await this.findCurrentRoom(
                    this.pg,
                    p.userId,
                );
                throw currentRoom
                    ? this.membershipElsewhereConflict(currentRoom)
                    : new ConflictException(
                          "You already belong to an active watch room. Leave that room before joining another one.",
                      );
            }
            this.logger.error({
                message: "Failed room participant association",
                roomCode: cleanCode,
                userId: p.userId,
                err: error,
            });

            throw error;
        }
    }

    async disassociateParticipant(participantId: string): Promise<{
        roomId: string;
        roomCode: string;
        participantCount: number;
    } | null> {
        try {
            const result = await this.pg.withTransaction(
                async (transactionClient) => {
                    const membershipLookup = await transactionClient.query<{
                        room_id: string;
                    }>(
                        `SELECT room_id FROM public.room_participants WHERE id = $1 LIMIT 1`,
                        [participantId],
                    );
                    if (!membershipLookup.rows[0]) return null;

                    // All membership exits lock the room first, matching owner termination.
                    const roomResult =
                        await transactionClient.query<RoomStatusRow>(
                            `SELECT id, room_code, lifecycle_status
                         FROM public.rooms WHERE id = $1 FOR UPDATE`,
                            [membershipLookup.rows[0].room_id],
                        );
                    const room = roomResult.rows[0];
                    if (!room || room.lifecycle_status !== "ACTIVE") {
                        return null;
                    }

                    const deactivated = await transactionClient.query(
                        `
                        UPDATE public.room_participants
                        SET is_active = false,
                            left_at = NOW()
                        WHERE id = $1 AND room_id = $2
                        AND is_active = true
                        RETURNING id
                        `,
                        [participantId, room.id],
                    );
                    if (!deactivated.rowCount) return null;

                    const countResult = await transactionClient.query<CountRow>(
                        `
                        SELECT COUNT(*)::int AS count
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                        [room.id],
                    );

                    await transactionClient.query(
                        `UPDATE public.rooms SET state_version = state_version + 1 WHERE id = $1`,
                        [room.id],
                    );
                    await this.lifecycleOutbox.enqueueRoomReconciliation(
                        transactionClient,
                        room.id,
                    );

                    return {
                        roomId: room.id,
                        roomCode: room.room_code,
                        participantCount: countResult.rows[0].count,
                    };
                },
            );

            if (!result) {
                this.logger.debug({
                    message: "Participant cleanup was already complete",
                    participantId,
                });
                return null;
            }

            this.logger.log({
                message:
                    "Participant membership deactivated without deleting history",
                participantId,
                roomId: result.roomId,
                participantCount: result.participantCount,
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: "Failed to deactivate room participant membership",
                participantId,
                err: error,
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
    async leaveRoomSession(
        userId: string,
        roomId?: string,
    ): Promise<{
        status: string;
        roomCode?: string;
        roomId?: string;
        membersToKick?: string[];
        participantCount?: number;
    }> {
        const result = await this.pg.withTransaction(
            async (transactionClient) => {
                const userSessionResult =
                    await transactionClient.query<UserSessionRow>(
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
                    AND r.lifecycle_status IN ('PROVISIONING', 'ACTIVE')
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
                        const inactiveRoomResult =
                            await transactionClient.query<InactiveRoomRow>(
                                `
                            SELECT id AS room_id, room_code, owner_id, lifecycle_status
                            FROM public.rooms
                            WHERE id = $1
                            LIMIT 1`,
                                [roomId],
                            );

                        const inactiveRoom = inactiveRoomResult.rows[0];

                        if (
                            inactiveRoom &&
                            inactiveRoom.owner_id === userId &&
                            ["TERMINATING", "TERMINATED"].includes(
                                inactiveRoom.lifecycle_status,
                            )
                        ) {
                            return {
                                status: "ROOM_ALREADY_TERMINATING",
                                roomCode: inactiveRoom.room_code,
                                roomId: inactiveRoom.room_id,
                                participantCount: 0,
                            };
                        }
                    }

                    return {
                        status: "NO_ACTIVE_SESSION",
                    };
                }

                const session = userSessionResult.rows[0];

                const { room_id, room_code, owner_id } = session;

                if (owner_id === userId) {
                    this.logger.log({
                        message:
                            "Owner disconnected. Cleaning up room engine entirely.",
                        roomCode: room_code,
                        ownerId: userId,
                    });

                    const membersResult =
                        await transactionClient.query<MemberUserRow>(
                            `
                        SELECT user_id
                        FROM public.room_participants
                        WHERE room_id = $1
                        AND is_active = true
                        `,
                            [room_id],
                        );

                    const membersToKick = membersResult.rows.map(
                        (member) => member.user_id,
                    );

                    await transactionClient.query(
                        `
                        UPDATE public.rooms
                        SET is_active = false,
                            lifecycle_status = 'TERMINATING',
                            state_version = state_version + 1
                        WHERE id = $1
                          AND lifecycle_status IN ('PROVISIONING', 'ACTIVE')
                        `,
                        [room_id],
                    );

                    await this.lifecycleOutbox.enqueueRoomReconciliation(
                        transactionClient,
                        room_id,
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
                        status: "ROOM_DESTROYED",
                        roomCode: room_code,
                        roomId: room_id,
                        membersToKick,
                        participantCount: 0,
                    };
                }

                this.logger.log({
                    message:
                        "Participant disconnected. Removing from tracking relation.",
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
                    [room_id, userId],
                );

                const countResult = await transactionClient.query<CountRow>(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM public.room_participants
                    WHERE room_id = $1
                    AND is_active = true
                    `,
                    [room_id],
                );

                await transactionClient.query(
                    `UPDATE public.rooms SET state_version = state_version + 1 WHERE id = $1`,
                    [room_id],
                );
                await this.lifecycleOutbox.enqueueRoomReconciliation(
                    transactionClient,
                    room_id,
                );

                return {
                    status: "PARTICIPANT_EVICTED",
                    roomCode: room_code,
                    roomId: room_id,
                    participantCount: countResult.rows[0].count,
                };
            },
        );

        if (result.status === "NO_ACTIVE_SESSION") {
            return result;
        }

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
                (lifecycle_status = 'ACTIVE') AS "isActive",
                lifecycle_status AS "lifecycleStatus"
            FROM public.rooms
            WHERE UPPER(TRIM(room_code)) = $1
            AND lifecycle_status = 'ACTIVE'
        `;

        try {
            const cleanCode = roomCode.trim().toUpperCase();

            const result = await this.pg.query<RoomDetails>(query, [cleanCode]);

            if (result.rows.length === 0) {
                this.logger.warn({
                    message: "Room lookup failed: Code not found or inactive",
                    roomCode,
                });

                return null;
            }

            return result.rows[0];
        } catch (error) {
            this.logger.error({
                message: "Failed to execute room database lookup query",
                roomCode,
                err: error,
            });

            throw error;
        }
    }

    async assertRoomActive(roomId: string): Promise<void> {
        const result = await this.pg.query(
            `SELECT id FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE' LIMIT 1`,
            [roomId],
        );
        if (!result.rows[0]) {
            throw new ConflictException(
                "The watch room is no longer accepting participants.",
            );
        }
    }

    /**
     * The room a user currently occupies, if any: an active membership in a
     * PROVISIONING/ACTIVE room, or a PROVISIONING/ACTIVE room they own.
     * `excludeRoomId` skips the room being joined.
     */
    private async findCurrentRoom(
        executor: PoolClient | PostgresProvider,
        userId: string,
        excludeRoomId?: string,
    ): Promise<{ roomId: string; roomCode: string; isOwner: boolean } | null> {
        // Same SQL inside a transaction (PoolClient) or on the pool (PostgresProvider).
        const query = (text: string, params: unknown[]) =>
            (
                executor as {
                    query: (
                        text: string,
                        params: unknown[],
                    ) => Promise<{ rows: unknown[] }>;
                }
            ).query(text, params);
        const result = await query(
            `SELECT r.id, r.room_code, (r.owner_id = $1) AS is_owner
             FROM public.rooms r
             WHERE r.lifecycle_status IN ('PROVISIONING', 'ACTIVE')
               AND ($2::uuid IS NULL OR r.id <> $2::uuid)
               AND (
                   r.owner_id = $1
                   OR EXISTS (
                       SELECT 1 FROM public.room_participants rp
                       WHERE rp.room_id = r.id AND rp.user_id = $1 AND rp.is_active = true
                   )
               )
             ORDER BY (r.owner_id = $1) DESC
             LIMIT 1`,
            [userId, excludeRoomId ?? null],
        );
        const row = result.rows[0] as
            | { id: string; room_code: string; is_owner: boolean }
            | undefined;
        return row
            ? { roomId: row.id, roomCode: row.room_code, isOwner: row.is_owner }
            : null;
    }

    /**
     * Structured 409 for "you are still in another room". The client offers
     * "leave it and continue", then retries with `leaveCurrent: true`.
     */
    private membershipElsewhereConflict(current: {
        roomId: string;
        roomCode: string;
        isOwner: boolean;
    }) {
        return new ConflictException({
            message: current.isOwner
                ? `You are still hosting room ${current.roomCode}. Leaving it will close it for everyone.`
                : `You are still in room ${current.roomCode}. Leave it before joining another room.`,
            error: {
                code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                roomId: current.roomId,
                roomCode: current.roomCode,
                isOwner: current.isOwner,
            },
        });
    }

    /**
     * Active memberships of ACTIVE rooms, used by the gateway presence sweeper to
     * find members that have no live socket (e.g. after a backend restart).
     */
    async listActiveMemberships(): Promise<
        Array<{
            participantId: string;
            roomId: string;
            roomCode: string;
            userId: string;
            isOwner: boolean;
        }>
    > {
        const result = await this.pg.query<ActiveMembershipRow>(
            `SELECT rp.id AS participant_id, rp.room_id, rp.user_id,
                    r.room_code, r.owner_id
             FROM public.room_participants rp
             INNER JOIN public.rooms r ON r.id = rp.room_id
             WHERE rp.is_active = true
               AND r.lifecycle_status = 'ACTIVE'`,
        );

        return result.rows.map((row) => ({
            participantId: row.participant_id,
            roomId: row.room_id,
            roomCode: row.room_code,
            userId: row.user_id,
            isOwner: row.owner_id === row.user_id,
        }));
    }

    /** Authoritative inputs for rebuilding a room's Redis projection. */
    async getRoomProjectionState(roomId: string): Promise<{
        roomId: string;
        roomCode: string;
        ownerId: string;
        movieId: string;
        maxParticipants: number;
        lifecycleStatus: string;
        stateVersion: string;
        participantCount: number;
    } | null> {
        const result = await this.pg.query<RoomProjectionRow>(
            `SELECT r.id, r.room_code, r.owner_id, r.movie_id, r.max_participants,
                    r.lifecycle_status, r.state_version,
                    (SELECT COUNT(*)::int FROM public.room_participants rp
                     WHERE rp.room_id = r.id AND rp.is_active = true) AS participant_count
             FROM public.rooms r WHERE r.id = $1`,
            [roomId],
        );
        const row = result.rows[0];
        if (!row) return null;

        return {
            roomId: row.id,
            roomCode: row.room_code,
            ownerId: row.owner_id,
            movieId: row.movie_id,
            maxParticipants: row.max_participants,
            lifecycleStatus: row.lifecycle_status,
            stateVersion: String(row.state_version),
            participantCount: row.participant_count,
        };
    }
}
