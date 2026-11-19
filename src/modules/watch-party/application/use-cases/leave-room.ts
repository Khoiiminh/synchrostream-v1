import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import type { WatchPartyLogger } from "../logger.port.js";
import type { LifecycleOutboxPort } from "../ports/collaborators.port.js";
import { isShuttingDown } from "../../domain/room.js";

/** Use case: a member leaves (membership ends) or the owner leaves (room → TERMINATING). */
export class LeaveRoom {
    constructor(
        private readonly repo: WatchPartyStore,
        private readonly lifecycleOutbox: LifecycleOutboxPort,
        private readonly logger: WatchPartyLogger,
    ) {}

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
    async execute(
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
}
