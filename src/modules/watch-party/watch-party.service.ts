import { Inject, Injectable, Logger } from "@nestjs/common";
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
import { JOIN_PASSWORD_RULE } from "@/shared/infrastructure/cache/attempt-limiter.js";
import type { WatchPartyStore } from "./application/ports/watch-party-store.port.js";
import type { Tx } from "./application/ports/transaction.js";
import type {
    AttemptLimiterPort,
    LifecycleOutboxPort,
    PasswordHasher,
} from "./application/ports/collaborators.port.js";
import {
    ActiveMembershipConflict,
    RoomCodeConflict,
} from "./application/ports/store-errors.js";
import {
    ATTEMPT_LIMITER,
    LIFECYCLE_OUTBOX,
    PASSWORD_HASHER,
    WATCH_PARTY_STORE,
} from "./application/ports/tokens.js";
import {
    AlreadyInActiveRoom,
    MemberOfAnotherRoom,
    OwnerAlreadyHasRoom,
    RoomCodeTaken,
    RoomNotAcceptingParticipants,
    WrongRoomPassword,
} from "./domain/errors.js";
import {
    ROOM_PASSWORD_MAX_LENGTH,
    ROOM_PASSWORD_MIN_LENGTH,
    assertUsableRoomPassword,
} from "./domain/room-password.js";
import {
    generateRoomCode,
    normalizeRoomCode,
    shouldRetryRoomCode,
} from "./domain/room-code.js";
import {
    assertJoinIdentity,
    assertJoinPasswordPresent,
    assertRoomHasCapacity,
    assertRoomJoinable,
    isJoinPasswordRequired,
} from "./domain/membership.js";
import { acceptsParticipants, isShuttingDown } from "./domain/room.js";
import { withHttpErrors } from "./presentation/error-mapper.js";

// Re-exported: the DTOs below and existing importers read them from here.
export { ROOM_PASSWORD_MAX_LENGTH, ROOM_PASSWORD_MIN_LENGTH };


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
        minLength: ROOM_PASSWORD_MIN_LENGTH,
        maxLength: ROOM_PASSWORD_MAX_LENGTH,
    })
    @IsString()
    @Length(ROOM_PASSWORD_MIN_LENGTH, ROOM_PASSWORD_MAX_LENGTH)
    @Matches(/\S/, { message: "Room password cannot be blank." })
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
        @Inject(WATCH_PARTY_STORE) private readonly repo: WatchPartyStore,
        @Inject(LIFECYCLE_OUTBOX)
        private readonly lifecycleOutbox: LifecycleOutboxPort,
        @Inject(ATTEMPT_LIMITER)
        private readonly attemptLimiter: AttemptLimiterPort,
        @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
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
        return withHttpErrors(() => this.createRoom(p));
    }

    private async createRoom(p: { dto: CreateRoomDto; ownerId: string }) {
        this.logger.debug({
            message: "Initiating session generation sequence for watch room",
            ownerId: p.ownerId,
            movieId: p.dto.movieId,
        });

        const requestedRoomCode =
            p.dto.roomCode == null ? undefined : normalizeRoomCode(p.dto.roomCode);

        // Enforced here as well as on the DTO, so every caller is covered.
        assertUsableRoomPassword(p.dto.passwordPlain);

        // Hash once, outside the transaction, so no lock is held while hashing runs.
        const passwordHash = await this.passwords.hash(p.dto.passwordPlain);

        // An active room must be terminated through the gateway lifecycle first.
        // The advisory transaction lock serializes room creation for one owner,
        // including requests handled by different backend instances.

        // The case: 'the same owner submits two room-creation requests almost simultaneously.'
        for (let codeAttempt = 0; ; codeAttempt += 1) {
            // Server-generated codes are retried on collision with a reserved code.
            const cleanRoomCode = requestedRoomCode ?? generateRoomCode();
            try {
                // Check ownership
                const room = await this.repo.withTransaction(
                    async (transactionClient) => {
                        await this.repo.acquireOwnerRoomCreationLock(
                            transactionClient,
                            p.ownerId,
                        );

                        // A TERMINATING room can never become available again, so it does
                        // not block a new room; it keeps only its code reserved while the
                        // outbox finishes provider and projection cleanup.
                        const existingRoom = await this.repo.findOwnedLiveRoom(
                            transactionClient,
                            p.ownerId,
                        );

                        if (existingRoom) {
                            throw new OwnerAlreadyHasRoom(
                                existingRoom.id,
                                existingRoom.room_code,
                            );
                        }

                        // Clear memberships only after their owning room has fully terminated.
                        await this.repo.deactivateMembershipsInTerminatedRooms(
                            transactionClient,
                            p.ownerId,
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
                        const createdRoom =
                            await this.repo.insertProvisioningRoom(
                                transactionClient,
                                {
                                    roomCode: cleanRoomCode,
                                    passwordHash,
                                    ownerId: p.ownerId,
                                    movieId: p.dto.movieId,
                                    maxParticipants: p.dto.maxParticipants || 5,
                                },
                            );

                        await this.lifecycleOutbox.enqueueRoomReconciliation(
                            transactionClient,
                            createdRoom.id,
                        );

                        await this.repo.insertOwnerParticipant(
                            transactionClient,
                            createdRoom.id,
                            p.ownerId,
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
                if (error instanceof ActiveMembershipConflict) {
                    // A concurrent join committed first; report which room, so the
                    // client can offer to switch.
                    const currentRoom = await this.findCurrentRoom(
                        undefined,
                        p.ownerId,
                    );
                    throw currentRoom
                        ? this.membershipElsewhereConflict(currentRoom)
                        : new AlreadyInActiveRoom("create");
                }
                if (error instanceof RoomCodeConflict) {
                    if (
                        shouldRetryRoomCode({
                            requestedCode: requestedRoomCode,
                            attempt: codeAttempt,
                        })
                    ) {
                        continue;
                    }
                    throw new RoomCodeTaken(requestedRoomCode || null);
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
     * 2. **Security Verification**: Validates the room's password, except for the room owner and
     *    for a user who already holds an ACTIVE participant record in this room (a reconnect).
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
        return withHttpErrors(() => this.joinRoom(p));
    }

    private async joinRoom(p: { dto: JoinRoomDto; userId: string }) {
        const cleanCode = normalizeRoomCode(p.dto.roomCode);

        assertJoinIdentity(p.userId);

        try {
            const result = await this.repo.withTransaction(
                async (transactionClient) => {
                    /*
                     * Lock the room row so two concurrent joins cannot both
                     * observe the same available capacity.
                     */
                    const lockedRoom = await this.repo.lockLiveRoomByCode(
                        transactionClient,
                        cleanCode,
                    );

                    if (!lockedRoom) {
                        this.logger.warn({
                            message:
                                "Join room rejected: Active room not found",
                            roomCode: cleanCode,
                            userId: p.userId,
                        });
                    }

                    // PROVISIONING (committed, not yet activated by the outbox) is
                    // a retryable 503; no room is a 404.
                    assertRoomJoinable(lockedRoom);

                    const room = lockedRoom;

                    /*
                     * First determine whether this user already has an
                     * ACTIVE participant record in this room.
                     *
                     * If yes, that record is reused.
                     */
                    const existingParticipant =
                        await this.repo.findActiveParticipant(
                            transactionClient,
                            room.id,
                            p.userId,
                        );

                    const isOwner = p.userId === room.owner_id;

                    // Owner and reconnecting members skip the password (domain/membership.ts).
                    const passwordRequired = isJoinPasswordRequired({
                        isOwner,
                        hasActiveMembership: Boolean(existingParticipant),
                    });
                    const attemptId = `${room.id}:${p.userId}`;

                    if (passwordRequired) {
                        // Blank is rejected before the limiter: nothing was guessed.
                        try {
                            assertJoinPasswordPresent(p.dto.passwordPlain);
                        } catch (missingPassword) {
                            this.logger.warn({
                                message:
                                    "Join room rejected: Room password missing",
                                roomCode: cleanCode,
                                roomId: room.id,
                                userId: p.userId,
                            });
                            throw missingPassword;
                        }

                        /*
                         * Wrong-password limit, checked before bcrypt so a
                         * blocked guesser costs no hashing while the room row
                         * is locked. Only first entries are counted; the owner
                         * and reconnecting members never reach this branch.
                         * Fails open when Redis is unavailable.
                         */
                        await this.attemptLimiter.assertAllowed(
                            JOIN_PASSWORD_RULE,
                            attemptId,
                        );

                        if (
                            !(await this.passwords.compare(
                                p.dto.passwordPlain,
                                room.password,
                            ))
                        ) {
                            await this.attemptLimiter.recordFailure(
                                JOIN_PASSWORD_RULE,
                                attemptId,
                            );

                            this.logger.warn({
                                message:
                                    "Join room rejected: Invalid room credentials",
                                roomCode: cleanCode,
                                roomId: room.id,
                                userId: p.userId,
                            });

                            throw new WrongRoomPassword();
                        }

                        await this.attemptLimiter.reset(
                            JOIN_PASSWORD_RULE,
                            attemptId,
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
                        const participantCount =
                            await this.repo.countActiveParticipants(
                                transactionClient,
                                room.id,
                            );

                        assertRoomHasCapacity({
                            activeCount: participantCount,
                            capacity: room.max_participants,
                        });

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

                        participant = await this.repo.insertParticipant(
                            transactionClient,
                            room.id,
                            p.userId,
                        );
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
                    const participantCount =
                        await this.repo.countActiveParticipants(
                            transactionClient,
                            room.id,
                        );

                    let stateVersion = room.state_version;
                    if (createdMembership) {
                        stateVersion =
                            await this.repo.incrementActiveRoomStateVersion(
                                transactionClient,
                                room.id,
                            );
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
            if (error instanceof ActiveMembershipConflict) {
                this.logger.warn({
                    message:
                        "Join rejected: User already has an active room membership",
                    roomCode: cleanCode,
                    userId: p.userId,
                    constraint: "idx_one_active_room_per_user",
                });

                const currentRoom = await this.findCurrentRoom(
                    undefined,
                    p.userId,
                );
                throw currentRoom
                    ? this.membershipElsewhereConflict(currentRoom)
                    : new AlreadyInActiveRoom("join");
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
            const result = await this.repo.withTransaction(
                async (transactionClient) => {
                    const membershipRoomId =
                        await this.repo.findParticipantRoomId(
                            transactionClient,
                            participantId,
                        );
                    if (!membershipRoomId) return null;

                    // All membership exits lock the room first, matching owner termination.
                    const room = await this.repo.lockRoomStatus(
                        transactionClient,
                        membershipRoomId,
                    );
                    if (!room || !acceptsParticipants(room.lifecycle_status)) {
                        return null;
                    }

                    const deactivated = await this.repo.deactivateParticipant(
                        transactionClient,
                        participantId,
                        room.id,
                    );
                    if (!deactivated) return null;

                    const participantCount =
                        await this.repo.countActiveParticipants(
                            transactionClient,
                            room.id,
                        );

                    await this.repo.incrementRoomStateVersion(
                        transactionClient,
                        room.id,
                    );
                    await this.lifecycleOutbox.enqueueRoomReconciliation(
                        transactionClient,
                        room.id,
                    );

                    return {
                        roomId: room.id,
                        roomCode: room.room_code,
                        participantCount,
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
        const result = await this.repo.withTransaction(
            async (transactionClient) => {
                const session = await this.repo.lockUserLiveSession(
                    transactionClient,
                    userId,
                    roomId,
                );

                if (!session) {
                    // An earlier cleanup attempt may have deactivated the room
                    // in PostgreSQL but failed while deleting its Redis projection.
                    // Return the exact inactive owner room so a retry can finish cleanup
                    if (roomId) {
                        const inactiveRoom = await this.repo.findRoomLifecycle(
                            transactionClient,
                            roomId,
                        );

                        if (
                            inactiveRoom &&
                            inactiveRoom.owner_id === userId &&
                            isShuttingDown(inactiveRoom.lifecycle_status)
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

                const { room_id, room_code, owner_id } = session;

                if (owner_id === userId) {
                    this.logger.log({
                        message:
                            "Owner disconnected. Cleaning up room engine entirely.",
                        roomCode: room_code,
                        ownerId: userId,
                    });

                    const membersToKick =
                        await this.repo.listActiveMemberUserIds(
                            transactionClient,
                            room_id,
                        );

                    await this.repo.markRoomTerminating(
                        transactionClient,
                        room_id,
                    );

                    await this.lifecycleOutbox.enqueueRoomReconciliation(
                        transactionClient,
                        room_id,
                    );

                    await this.repo.deactivateAllRoomParticipants(
                        transactionClient,
                        room_id,
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

                await this.repo.deactivateUserMembership(
                    transactionClient,
                    room_id,
                    userId,
                );

                const participantCount =
                    await this.repo.countActiveParticipants(
                        transactionClient,
                        room_id,
                    );

                await this.repo.incrementRoomStateVersion(
                    transactionClient,
                    room_id,
                );
                await this.lifecycleOutbox.enqueueRoomReconciliation(
                    transactionClient,
                    room_id,
                );

                return {
                    status: "PARTICIPANT_EVICTED",
                    roomCode: room_code,
                    roomId: room_id,
                    participantCount,
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
        try {
            const cleanCode = normalizeRoomCode(roomCode);

            const room = await this.repo.findActiveRoomDetailsByCode(cleanCode);

            if (!room) {
                this.logger.warn({
                    message: "Room lookup failed: Code not found or inactive",
                    roomCode,
                });

                return null;
            }

            return room;
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
        return withHttpErrors(async () => {
            if (!(await this.repo.isRoomActive(roomId))) {
                throw new RoomNotAcceptingParticipants();
            }
        });
    }

    /**
     * The room a user currently occupies, if any: an active membership in a
     * PROVISIONING/ACTIVE room, or a PROVISIONING/ACTIVE room they own.
     * `excludeRoomId` skips the room being joined.
     */
    private async findCurrentRoom(
        executor: Tx | undefined,
        userId: string,
        excludeRoomId?: string,
    ): Promise<{ roomId: string; roomCode: string; isOwner: boolean } | null> {
        // `executor` is the open transaction, or `undefined` for the pool.
        const row = await this.repo.findCurrentRoom(
            executor,
            userId,
            excludeRoomId,
        );
        return row
            ? { roomId: row.id, roomCode: row.room_code, isOwner: row.is_owner }
            : null;
    }

    /**
     * "You are still in another room". Mapped to the structured 409 the client
     * answers with "leave it and continue" (`leaveCurrent: true`).
     */
    private membershipElsewhereConflict(current: {
        roomId: string;
        roomCode: string;
        isOwner: boolean;
    }) {
        return new MemberOfAnotherRoom(
            current.roomId,
            current.roomCode,
            current.isOwner,
        );
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
        const rows = await this.repo.listActiveMemberships();

        return rows.map((row) => ({
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
        const row = await this.repo.findRoomProjection(roomId);
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
