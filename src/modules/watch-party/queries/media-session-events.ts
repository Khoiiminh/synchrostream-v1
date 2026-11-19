import { Injectable } from "@nestjs/common";
import type { SqlExecutor } from "@/shared/infrastructure/database/sql-executor.js";

/*
 * Watch-party's published write contract for its lifecycle outbox
 * (refactor plan §6): other modules enqueue LIVEKIT_SESSION_RECONCILE here
 * instead of inserting into `room_lifecycle_outbox` themselves. Both methods
 * run inside the caller's transaction so the event commits with the change.
 *
 * SQL moved byte-for-byte from livekit.repository.ts.
 */
@Injectable()
export class MediaSessionEvents {
    /** Enqueues a LIVEKIT_SESSION_RECONCILE event delayed past the startup window. */
    async enqueueDelayedSessionReconcile(
        db: SqlExecutor,
        mediaSessionId: string,
    ): Promise<void> {
        await db.query(
            `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id, next_attempt_at)
                 VALUES ('LIVEKIT_SESSION_RECONCILE', $1, NOW() + INTERVAL '35 seconds')`,
            [mediaSessionId],
        );
    }

    /** Enqueues an immediately due LIVEKIT_SESSION_RECONCILE event. */
    async enqueueSessionReconcile(
        db: SqlExecutor,
        mediaSessionId: string,
    ): Promise<void> {
        await db.query(
            `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
                 VALUES ('LIVEKIT_SESSION_RECONCILE', $1)`,
            [mediaSessionId],
        );
    }
}
