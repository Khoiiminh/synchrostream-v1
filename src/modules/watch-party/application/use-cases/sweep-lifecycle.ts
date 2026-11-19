import type { WatchPartyLogger } from "../logger.port.js";
import type { OutboxStore } from "../ports/outbox-store.port.js";
import {
    COMPLETED_RETENTION_DAYS,
    PROVISIONING_TIMEOUT_MINUTES,
    STUCK_MEDIA_SESSION_MINUTES,
} from "./outbox-policy.js";

/**
 * Periodic convergence pass. One instance runs it per tick (advisory lock).
 * - PROVISIONING rooms past the timeout are moved to TERMINATING.
 * - PROVISIONING/TERMINATING rooms with no live event get a new one, so a
 *   DEAD event never leaves a room stuck (the DEAD row stays for diagnostics).
 * - Stuck LiveKit sessions (STARTING/ENDING, or CREATED on a room that is
 *   no longer ACTIVE) with no live event get a new one.
 * - Old COMPLETED events are pruned.
 */
export class SweepLifecycle {
    constructor(
        private readonly repo: OutboxStore,
        private readonly logger: WatchPartyLogger,
    ) {}

    /** One pass; a no-op when another instance holds the sweeper lock. */
    async execute(): Promise<void> {
        await this.repo.withTransaction(async (client) => {
            if (!(await this.repo.tryAcquireSweeperLock(client))) return;

            const timedOut = await this.repo.terminateTimedOutProvisioningRooms(
                client,
                PROVISIONING_TIMEOUT_MINUTES,
            );
            for (const room of timedOut) {
                await this.repo.deactivateActiveParticipants(client, room.id);
                await this.repo.enqueueRoomReconciliation(client, room.id);
                this.logger.warn({
                    message:
                        "Room could not be provisioned in time and is being terminated",
                    roomId: room.id,
                    timeoutMinutes: PROVISIONING_TIMEOUT_MINUTES,
                });
            }

            const requeuedRooms =
                await this.repo.requeueUnconvergedRooms(client);

            // Rooms without lifecycle states before v7 cannot be told apart by
            // provider; only transitional or orphaned sessions are touched, and
            // ending one deletes a LiveKit room by its id (404 = success).
            const requeuedSessions = await this.repo.requeueStuckMediaSessions(
                client,
                STUCK_MEDIA_SESSION_MINUTES,
            );

            const pruned = await this.repo.pruneCompletedEvents(
                client,
                COMPLETED_RETENTION_DAYS,
            );

            if (requeuedRooms || requeuedSessions) {
                this.logger.warn({
                    message:
                        "Lifecycle sweeper re-enqueued unconverged aggregates",
                    rooms: requeuedRooms,
                    mediaSessions: requeuedSessions,
                });
            }
            if (pruned) {
                this.logger.debug({
                    message: "Pruned completed lifecycle events",
                    count: pruned,
                });
            }
        });
    }
}
