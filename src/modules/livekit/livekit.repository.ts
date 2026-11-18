import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    SqlExecutor,
    TransactionClient,
} from "@/shared/infrastructure/database/sql-executor.js";
import type { MediaSessionRow } from "../media-session-sfu/media-session.types.js";
import type { ActiveParticipantRow, ActiveRoomRow } from "./livekit.types.js";

/**
 * All SQL for LiveKit media-session lifecycle: room/membership checks and the
 * guarded `media_sessions` status transitions with their outbox events.
 *
 * Note: SQL text inside template literals is kept byte-for-byte identical to
 * the original service implementation, including continuation-line indentation.
 */
@Injectable()
export class LiveKitRepository {
    constructor(private readonly pg: PostgresProvider) {}

    withTransaction<T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> {
        return this.pg.withTransaction(cb);
    }

    /** Membership id of an active member of an ACTIVE room, if any. */
    async findActiveMembershipId(
        roomId: string,
        userId: string,
    ): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            `SELECT rp.id
             FROM public.room_participants rp
             INNER JOIN public.rooms r ON r.id = rp.room_id
             WHERE rp.room_id = $1 AND rp.user_id = $2
               AND rp.is_active = true AND r.lifecycle_status = 'ACTIVE'
             LIMIT 1`,
            [roomId, userId],
        );
        return result.rows[0]?.id;
    }

    /** Whether the room exists and is ACTIVE (`SELECT 1` probe). */
    async isRoomActive(roomId: string): Promise<boolean> {
        const result = await this.pg.query(
            `SELECT 1 FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE'`,
            [roomId],
        );
        return Boolean(result.rows[0]);
    }

    /** Id of the room if it exists and is ACTIVE. */
    async findActiveRoomId(roomId: string): Promise<string | undefined> {
        const result = await this.pg.query<{ id: string }>(
            `SELECT id FROM public.rooms WHERE id = $1 AND lifecycle_status = 'ACTIVE' LIMIT 1`,
            [roomId],
        );
        return result.rows[0]?.id;
    }

    /** The active participant row for a user in an ACTIVE room, if any. */
    async findActiveParticipant(
        roomId: string,
        userId: string,
    ): Promise<ActiveParticipantRow | undefined> {
        const participantQuery = `
            SELECT
                rp.id AS participant_id,
                rp.user_id,
                rp.room_id
            FROM public.room_participants rp
            INNER JOIN public.rooms r ON r.id = rp.room_id
            WHERE rp.room_id = $1
            AND rp.user_id = $2
            AND rp.is_active = true
            AND r.lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const result = await this.pg.query<ActiveParticipantRow>(
            participantQuery,
            [roomId, userId],
        );
        return result.rows[0];
    }

    /** The ACTIVE room with its capacity, if it exists. */
    async findActiveRoom(roomId: string): Promise<ActiveRoomRow | undefined> {
        const roomQuery = `
            SELECT
                id,
                max_participants
            FROM public.rooms
            WHERE id = $1
            AND lifecycle_status = 'ACTIVE'
            LIMIT 1
        `;

        const result = await this.pg.query<ActiveRoomRow>(roomQuery, [roomId]);
        return result.rows[0];
    }

    /** Locks the room row `FOR UPDATE` if ACTIVE; returns whether it was found. */
    async lockActiveRoom(db: SqlExecutor, roomId: string): Promise<boolean> {
        const result = await db.query(
            `SELECT id FROM public.rooms
                 WHERE id = $1 AND lifecycle_status = 'ACTIVE'
                 FOR UPDATE`,
            [roomId],
        );
        return Boolean(result.rows[0]);
    }

    /** Guarded CREATED -> STARTING transition. */
    async markSessionStarting(
        db: SqlExecutor,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSessionRow | undefined> {
        const result = await db.query<MediaSessionRow>(
            `UPDATE public.media_sessions SET status = 'STARTING'
                 WHERE id = $1 AND room_id = $2 AND status = 'CREATED'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId, roomId],
        );
        return result.rows[0];
    }

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

    /** Guarded STARTING -> ACTIVE transition. */
    async markSessionActive(
        db: SqlExecutor,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSessionRow | undefined> {
        const result = await db.query<MediaSessionRow>(
            `UPDATE public.media_sessions
                 SET status = 'ACTIVE', started_at = COALESCE(started_at, NOW())
                 WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId, roomId],
        );
        return result.rows[0];
    }

    /** Guarded CREATED/STARTING/ACTIVE -> ENDING transition. */
    async markSessionEnding(
        db: SqlExecutor,
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
        const result = await db.query<MediaSessionRow>(
            `UPDATE public.media_sessions
                 SET status = 'ENDING'
                 WHERE id = $1 AND status IN ('CREATED', 'STARTING', 'ACTIVE')
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId],
        );
        return result.rows[0];
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
