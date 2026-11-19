import type { WatchPartyLogger } from "../logger.port.js";
import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import type { LifecycleOutboxPort } from "../ports/collaborators.port.js";
import { acceptsParticipants } from "../../domain/room.js";

/**
 * Use case: end one membership after its reconnection grace expired. Keeps
 * history (is_active = false, left_at). Idempotent: returns null when there
 * is nothing left to end.
 */
export class ExpireMembership {
    constructor(
        private readonly repo: WatchPartyStore,
        private readonly lifecycleOutbox: LifecycleOutboxPort,
        private readonly logger: WatchPartyLogger,
    ) {}

    async execute(participantId: string): Promise<{
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
}
