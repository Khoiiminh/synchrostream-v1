import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    SqlExecutor,
    TransactionClient,
} from "@/shared/infrastructure/database/sql-executor.js";
import type {
    IdRow,
    OutboxEvent,
    RoomCodeHolderRow,
    RoomProjectionRow,
} from "./watch-party.types.js";

/**
 * All SQL for the room lifecycle outbox, its sweeper and room reconciliation.
 *
 * Methods that may run inside a caller's transaction take `db` first. Passing
 * `undefined` runs the statement on the pool.
 */
@Injectable()
export class RoomLifecycleOutboxRepository {
    constructor(private readonly pg: PostgresProvider) {}

    withTransaction<T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> {
        return this.pg.withTransaction(cb);
    }

    async enqueueRoomReconciliation(
        db: SqlExecutor = this.pg,
        roomId: string,
    ): Promise<void> {
        await db.query(
            `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
             VALUES ('ROOM_RECONCILE', $1)`,
            [roomId],
        );
    }

    /** Leases the oldest due event (or one whose lease expired) to `workerId`. */
    async claimNextEvent(
        db: SqlExecutor = this.pg,
        workerId: string,
        leaseSeconds: number,
    ): Promise<OutboxEvent | null> {
        const claimed = await db.query<OutboxEvent>(
            `WITH next_event AS (
                    SELECT event_id
                    FROM public.room_lifecycle_outbox
                    WHERE event_type IN ('ROOM_RECONCILE', 'LIVEKIT_SESSION_RECONCILE')
                      AND next_attempt_at <= NOW()
                      AND (status = 'PENDING' OR (status = 'PROCESSING' AND locked_until < NOW()))
                    ORDER BY created_at, event_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                 )
                 UPDATE public.room_lifecycle_outbox AS event
                 SET status = 'PROCESSING',
                     locked_by = $1,
                     locked_until = NOW() + ($2 * INTERVAL '1 second'),
                     attempts = attempts + 1
                 FROM next_event
                 WHERE event.event_id = next_event.event_id
                 RETURNING event.event_id, event.event_type, event.aggregate_id, event.attempts, event.created_at`,
            [workerId, leaseSeconds],
        );
        return claimed.rows[0] ?? null;
    }

    async markEventCompleted(eventId: string, workerId: string): Promise<void> {
        await this.pg.query(
            `UPDATE public.room_lifecycle_outbox
                 SET status = 'COMPLETED', completed_at = NOW(), locked_by = NULL, locked_until = NULL,
                     last_error = NULL
                 WHERE event_id = $1 AND status = 'PROCESSING' AND locked_by = $2`,
            [eventId, workerId],
        );
    }

    /** Releases the lease and reschedules the event, or parks it as DEAD. */
    async markEventFailed(
        eventId: string,
        workerId: string,
        delaySeconds: number,
        lastError: string,
        deadLetter: boolean,
    ): Promise<void> {
        await this.pg.query(
            `UPDATE public.room_lifecycle_outbox
                 SET status = CASE WHEN $5 THEN 'DEAD' ELSE 'PENDING' END,
                     next_attempt_at = NOW() + ($3 * INTERVAL '1 second'),
                     locked_by = NULL, locked_until = NULL, last_error = $4
                 WHERE event_id = $1 AND status = 'PROCESSING' AND locked_by = $2`,
            [eventId, workerId, delaySeconds, lastError, deadLetter],
        );
    }

    /** Transaction-scoped advisory lock so one instance sweeps per tick. */
    async tryAcquireSweeperLock(db: SqlExecutor = this.pg): Promise<boolean> {
        const lock = await db.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtext('room-lifecycle-sweeper')) AS acquired`,
        );
        return Boolean(lock.rows[0]?.acquired);
    }

    /** Moves PROVISIONING rooms older than the timeout to TERMINATING; returns their ids. */
    async terminateTimedOutProvisioningRooms(
        db: SqlExecutor = this.pg,
        timeoutMinutes: number,
    ): Promise<IdRow[]> {
        const timedOut = await db.query<IdRow>(
            `WITH stuck AS (
                        SELECT id FROM public.rooms
                        WHERE lifecycle_status = 'PROVISIONING'
                          AND COALESCE(created_at, NOW()) < NOW() - ($1 * INTERVAL '1 minute')
                        FOR UPDATE SKIP LOCKED
                     )
                     UPDATE public.rooms AS r
                     SET lifecycle_status = 'TERMINATING', is_active = false,
                         state_version = r.state_version + 1
                     FROM stuck
                     WHERE r.id = stuck.id
                     RETURNING r.id`,
            [timeoutMinutes],
        );
        return timedOut.rows;
    }

    async deactivateActiveParticipants(
        db: SqlExecutor = this.pg,
        roomId: string,
    ): Promise<void> {
        await db.query(
            `UPDATE public.room_participants
                         SET is_active = false, left_at = NOW()
                         WHERE room_id = $1 AND is_active = true`,
            [roomId],
        );
    }

    /** Enqueues ROOM_RECONCILE for transitional rooms with no live event; returns rowCount. */
    async requeueUnconvergedRooms(
        db: SqlExecutor = this.pg,
    ): Promise<number | null> {
        const requeued =
            await db.query(`INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
                     SELECT 'ROOM_RECONCILE', r.id
                     FROM public.rooms r
                     WHERE r.lifecycle_status IN ('PROVISIONING', 'TERMINATING')
                       AND NOT EXISTS (
                           SELECT 1 FROM public.room_lifecycle_outbox o
                           WHERE o.aggregate_id = r.id
                             AND o.event_type = 'ROOM_RECONCILE'
                             AND o.status IN ('PENDING', 'PROCESSING')
                       )
                     RETURNING aggregate_id`);
        return requeued.rowCount;
    }

    /** Enqueues LIVEKIT_SESSION_RECONCILE for stuck media sessions with no live event; returns rowCount. */
    async requeueStuckMediaSessions(
        db: SqlExecutor = this.pg,
        stuckMinutes: number,
    ): Promise<number | null> {
        const requeued = await db.query(
            `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
                     SELECT 'LIVEKIT_SESSION_RECONCILE', ms.id
                     FROM public.media_sessions ms
                     LEFT JOIN public.rooms r ON r.id = ms.room_id
                     WHERE (
                             ms.status IN ('STARTING', 'ENDING')
                             OR (ms.status = 'CREATED' AND r.lifecycle_status IS DISTINCT FROM 'ACTIVE')
                           )
                       AND COALESCE(ms.created_at, NOW()) < NOW() - ($1 * INTERVAL '1 minute')
                       AND NOT EXISTS (
                           SELECT 1 FROM public.room_lifecycle_outbox o
                           WHERE o.aggregate_id = ms.id
                             AND o.event_type = 'LIVEKIT_SESSION_RECONCILE'
                             AND o.status IN ('PENDING', 'PROCESSING')
                       )
                     RETURNING aggregate_id`,
            [stuckMinutes],
        );
        return requeued.rowCount;
    }

    /** Deletes up to 1000 COMPLETED events older than the retention; returns rowCount. */
    async pruneCompletedEvents(
        db: SqlExecutor = this.pg,
        retentionDays: number,
    ): Promise<number | null> {
        const pruned = await db.query(
            `DELETE FROM public.room_lifecycle_outbox
                     WHERE event_id IN (
                         SELECT event_id FROM public.room_lifecycle_outbox
                         WHERE status = 'COMPLETED'
                           AND completed_at < NOW() - ($1 * INTERVAL '1 day')
                         LIMIT 1000
                     )`,
            [retentionDays],
        );
        return pruned.rowCount;
    }

    async findRoomProjection(
        roomId: string,
    ): Promise<RoomProjectionRow | undefined> {
        const roomResult = await this.pg.query<RoomProjectionRow>(
            `SELECT r.id, r.room_code, r.owner_id, r.movie_id, r.max_participants,
                    r.lifecycle_status, r.state_version,
                    (SELECT COUNT(*)::int FROM public.room_participants rp
                     WHERE rp.room_id = r.id AND rp.is_active = true) AS participant_count
             FROM public.rooms r WHERE r.id = $1`,
            [roomId],
        );
        return roomResult.rows[0];
    }

    /** PROVISIONING -> ACTIVE, guarded by the observed state version; returns rowCount. */
    async activateProvisioningRoom(
        db: SqlExecutor = this.pg,
        roomId: string,
        stateVersion: string,
    ): Promise<number | null> {
        const activated = await db.query(
            `UPDATE public.rooms
                     SET lifecycle_status = 'ACTIVE', is_active = true,
                         state_version = state_version + 1
                     WHERE id = $1 AND lifecycle_status = 'PROVISIONING' AND state_version = $2
                     RETURNING id`,
            [roomId, stateVersion],
        );
        return activated.rowCount;
    }

    /** TERMINATING -> TERMINATED, guarded by the observed state version; returns rowCount. */
    async markRoomTerminated(
        db: SqlExecutor = this.pg,
        roomId: string,
        stateVersion: string,
    ): Promise<number | null> {
        const terminated = await db.query(
            `UPDATE public.rooms
                     SET lifecycle_status = 'TERMINATED', state_version = state_version + 1
                     WHERE id = $1 AND lifecycle_status = 'TERMINATING' AND state_version = $2
                     RETURNING id`,
            [roomId, stateVersion],
        );
        return terminated.rowCount;
    }

    async listActiveParticipantIds(roomId: string): Promise<IdRow[]> {
        const members = await this.pg.query<IdRow>(
            `SELECT id FROM public.room_participants WHERE room_id = $1 AND is_active = true`,
            [roomId],
        );
        return members.rows;
    }

    async findRoomCodeHolder(
        roomId: string,
    ): Promise<RoomCodeHolderRow | undefined> {
        const holder = await this.pg.query<RoomCodeHolderRow>(
            `SELECT room_code, lifecycle_status FROM public.rooms WHERE id = $1`,
            [roomId],
        );
        return holder.rows[0];
    }
}
