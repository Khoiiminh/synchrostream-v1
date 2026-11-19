import type { WatchPartyLogger } from "../logger.port.js";
import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import type {
    AttemptLimiterPort,
    AttemptRule,
    LifecycleOutboxPort,
    PasswordHasher,
} from "../ports/collaborators.port.js";
import { ActiveMembershipConflict } from "../ports/store-errors.js";
import { AlreadyInActiveRoom, WrongRoomPassword } from "../../domain/errors.js";
import { normalizeRoomCode } from "../../domain/room-code.js";
import {
    assertJoinIdentity,
    assertJoinPasswordPresent,
    assertRoomHasCapacity,
    assertRoomJoinable,
    isJoinPasswordRequired,
} from "../../domain/membership.js";
import { findCurrentRoom, toMemberOfAnotherRoom } from "./current-room.js";
import type { JoinRoomInput } from "./inputs.js";

/** Use case: join (or rejoin) a room, enforcing password, capacity and one live room per user. */
export class JoinRoom {
    constructor(
        private readonly repo: WatchPartyStore,
        private readonly lifecycleOutbox: LifecycleOutboxPort,
        private readonly attemptLimiter: AttemptLimiterPort,
        private readonly passwords: PasswordHasher,
        /** Wrong-password limit (JOIN_PASSWORD_RULE), injected so this layer imports no infrastructure. */
        private readonly joinPasswordRule: AttemptRule,
        private readonly logger: WatchPartyLogger,
    ) {}

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
    async execute(p: { dto: JoinRoomInput; userId: string }) {
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
                            this.joinPasswordRule,
                            attemptId,
                        );

                        if (
                            !(await this.passwords.compare(
                                p.dto.passwordPlain,
                                room.password,
                            ))
                        ) {
                            await this.attemptLimiter.recordFailure(
                                this.joinPasswordRule,
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
                            this.joinPasswordRule,
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
                        const currentRoom = await findCurrentRoom(this.repo, 
                            transactionClient,
                            p.userId,
                            room.id,
                        );
                        if (currentRoom) {
                            throw toMemberOfAnotherRoom(currentRoom);
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

                const currentRoom = await findCurrentRoom(this.repo, 
                    undefined,
                    p.userId,
                );
                throw currentRoom
                    ? toMemberOfAnotherRoom(currentRoom)
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
}
