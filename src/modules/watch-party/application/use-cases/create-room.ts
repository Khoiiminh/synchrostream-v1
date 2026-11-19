import type { WatchPartyLogger } from "../logger.port.js";
import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import type {
    LifecycleOutboxPort,
    PasswordHasher,
} from "../ports/collaborators.port.js";
import {
    ActiveMembershipConflict,
    RoomCodeConflict,
} from "../ports/store-errors.js";
import {
    AlreadyInActiveRoom,
    OwnerAlreadyHasRoom,
    RoomCodeTaken,
} from "../../domain/errors.js";
import { assertUsableRoomPassword } from "../../domain/room-password.js";
import {
    generateRoomCode,
    normalizeRoomCode,
    shouldRetryRoomCode,
} from "../../domain/room-code.js";
import { findCurrentRoom, toMemberOfAnotherRoom } from "./current-room.js";
import type { CreateRoomInput } from "./inputs.js";

/** Use case: create a room (PROVISIONING) with its owner membership and outbox event. */
export class CreateRoom {
    constructor(
        private readonly repo: WatchPartyStore,
        private readonly lifecycleOutbox: LifecycleOutboxPort,
        private readonly passwords: PasswordHasher,
        private readonly logger: WatchPartyLogger,
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
    async execute(p: { dto: CreateRoomInput; ownerId: string }) {
        this.logger.debug({
            message: "Initiating session generation sequence for watch room",
            ownerId: p.ownerId,
            movieId: p.dto.movieId,
        });

        const requestedRoomCode =
            p.dto.roomCode == null
                ? undefined
                : normalizeRoomCode(p.dto.roomCode);

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
                        const currentRoom = await findCurrentRoom(
                            this.repo,
                            transactionClient,
                            p.ownerId,
                        );
                        if (currentRoom) {
                            throw toMemberOfAnotherRoom(currentRoom);
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
                    const currentRoom = await findCurrentRoom(
                        this.repo,
                        undefined,
                        p.ownerId,
                    );
                    throw currentRoom
                        ? toMemberOfAnotherRoom(currentRoom)
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
}
