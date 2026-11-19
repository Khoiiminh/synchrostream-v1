import type { WatchPartyLogger } from "../logger.port.js";
import type { OutboxStore } from "../ports/outbox-store.port.js";
import type { MediaSessionPort } from "../ports/collaborators.port.js";
import type { OutboxEvent } from "../../watch-party.types.js";
import type { ReconcileRoom } from "./reconcile-room.js";
import {
    DEAD_LETTER_ATTEMPTS,
    EVENT_TIMEOUT_MS,
    withTimeout,
} from "./outbox-policy.js";

/**
 * Use case: run one claimed outbox event, then mark it COMPLETED, or
 * reschedule it with backoff, or park it as DEAD after DEAD_LETTER_ATTEMPTS.
 */
export class ProcessOutboxEvent {
    constructor(
        private readonly repo: OutboxStore,
        private readonly reconcileRoom: ReconcileRoom,
        private readonly liveKit: MediaSessionPort,
        private readonly logger: WatchPartyLogger,
    ) {}

    async execute(event: OutboxEvent, workerId: string): Promise<void> {
        try {
            const work =
                event.event_type === "ROOM_RECONCILE"
                    ? this.reconcileRoom.execute(event.aggregate_id)
                    : this.liveKit.reconcileMediaSession(
                          event.aggregate_id,
                          event.created_at,
                      );
            await withTimeout(
                work,
                EVENT_TIMEOUT_MS,
                `${event.event_type} ${event.event_id}`,
            );

            await this.repo.markEventCompleted(event.event_id, workerId);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            const delaySeconds = Math.min(
                300,
                2 ** Math.min(event.attempts, 8),
            );
            const deadLetter = event.attempts >= DEAD_LETTER_ATTEMPTS;
            await this.repo.markEventFailed(
                event.event_id,
                workerId,
                delaySeconds,
                message.slice(0, 4000),
                deadLetter,
            );
            this.logger[deadLetter ? "error" : "warn"]({
                message: deadLetter
                    ? "Room lifecycle event reached the dead-letter threshold; the sweeper will re-enqueue the aggregate while it remains unconverged"
                    : "Room lifecycle reconciliation will be retried",
                eventId: event.event_id,
                eventType: event.event_type,
                aggregateId: event.aggregate_id,
                attempts: event.attempts,
                error: message,
            });
        }
    }
}
