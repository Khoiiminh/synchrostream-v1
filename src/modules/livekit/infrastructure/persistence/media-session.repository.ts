import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    SqlExecutor,
    TransactionClient,
} from "@/shared/infrastructure/database/sql-executor.js";
import { RoomAccessQuery } from "../../../watch-party/queries/room-access.query.js";
import { MediaSessionEvents } from "../../../watch-party/queries/media-session-events.js";
import type {
    MediaSession,
    MediaSessionStatus,
} from "../../domain/media-session.js";
import {
    OpenSessionConflict,
    type MediaSessionStore,
    type Tx,
} from "../../application/ports/media-session-store.port.js";

/** Row shape of `public.media_sessions` as selected and returned here. */
interface MediaSessionRow {
    id: string;
    room_id: string;
    status: MediaSessionStatus;
    assigned_sfu_node_id: string | null;
    created_at: Date;
    started_at: Date | null;
    ended_at: Date | null;
}

function toSession(row: MediaSessionRow | undefined): MediaSession | undefined {
    if (!row) return undefined;
    return {
        id: row.id,
        roomId: row.room_id,
        status: row.status,
        assignedSfuNodeId: row.assigned_sfu_node_id ?? null,
        createdAt: row.created_at,
        startedAt: row.started_at ?? null,
        endedAt: row.ended_at ?? null,
    };
}

function isOpenSessionUniqueViolation(error: unknown): boolean {
    const e = error as { code?: unknown; constraint?: unknown } | null;
    return (
        e?.code === "23505" &&
        (e.constraint === undefined ||
            e.constraint === "idx_active_media_session_room")
    );
}

/**
 * The `media_sessions` lifecycle rows. Room locks and outbox events go
 * through watch-party's contract (watch-party/queries), which owns those
 * tables, and run inside the caller's transaction.
 *
 * SQL text is byte-for-byte what MediaSessionRepository and
 * LiveKitRepository ran before the B2 split.
 */
@Injectable()
export class MediaSessionRepository implements MediaSessionStore {
    constructor(
        private readonly pg: PostgresProvider,
        /** Watch-party owns rooms and memberships; locks go through its contract. */
        private readonly rooms: RoomAccessQuery,
        /** Watch-party owns the lifecycle outbox; events go through its contract. */
        private readonly events: MediaSessionEvents,
    ) {}

    /** The only place a port transaction becomes a SQL executor. */
    private executor(tx: Tx): SqlExecutor {
        return tx as SqlExecutor;
    }

    withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
        return this.pg.withTransaction((client: TransactionClient) =>
            work(client),
        );
    }

    // ---- reads ----

    /** Any CREATED/STARTING/ACTIVE/ENDING session of the room (unordered). */
    async findAnyOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSession | undefined> {
        const existingSessionQuery = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE room_id = $1
              AND status IN (
                  'CREATED',
                  'STARTING',
                  'ACTIVE',
                  'ENDING'
              )
            LIMIT 1
        `;

        const result = await this.pg.query<MediaSessionRow>(
            existingSessionQuery,
            [roomId],
        );
        return toSession(result.rows[0]);
    }

    async findById(mediaSessionId: string): Promise<MediaSession | undefined> {
        const query = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE id = $1`;

        const result = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);
        return toSession(result.rows[0]);
    }

    /** Newest CREATED/STARTING/ACTIVE/ENDING session of the room. */
    async findLatestOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSession | undefined> {
        const query = `
            SELECT
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
            FROM public.media_sessions
            WHERE room_id = $1
            AND status IN (
                'CREATED',
                'STARTING',
                'ACTIVE',
                'ENDING'
            )
            ORDER BY created_at DESC
            LIMIT 1
        `;

        const result = await this.pg.query<MediaSessionRow>(query, [roomId]);
        return toSession(result.rows[0]);
    }

    // ---- writes outside a transaction ----

    /**
     * Inserts a CREATED session only while the room is ACTIVE, holding a share
     * lock on the room row. Returns undefined when the room is not ACTIVE.
     */
    async insertCreatedSessionIfRoomActive(
        roomId: string,
    ): Promise<MediaSession | undefined> {
        const insertQuery = `
                INSERT INTO public.media_sessions (
                    room_id,
                    status
                )
                SELECT r.id, 'CREATED'
                FROM public.rooms r
                WHERE r.id = $1
                  AND r.lifecycle_status = 'ACTIVE'
                FOR SHARE
                RETURNING
                    id,
                    room_id,
                    status,
                    assigned_sfu_node_id,
                    created_at,
                    started_at,
                    ended_at
            `;

        try {
            const result = await this.pg.query<MediaSessionRow>(insertQuery, [
                roomId,
            ]);
            return toSession(result.rows[0]);
        } catch (error) {
            if (isOpenSessionUniqueViolation(error)) {
                throw new OpenSessionConflict(error);
            }
            throw error;
        }
    }

    /** ENDING → ENDED. Undefined when the session was not ENDING. */
    async markEnded(mediaSessionId: string): Promise<MediaSession | undefined> {
        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ENDED',
                ended_at = NOW()
            WHERE id = $1
              AND status = 'ENDING'
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const result = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);
        return toSession(result.rows[0]);
    }

    // ---- guarded transitions inside a transaction ----

    /** Locks the room row `FOR UPDATE` if ACTIVE; returns whether it was found. */
    lockActiveRoom(tx: Tx, roomId: string): Promise<boolean> {
        return this.rooms.lockActiveRoom(this.executor(tx), roomId);
    }

    /** Guarded CREATED -> STARTING transition. */
    async markSessionStarting(
        tx: Tx,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession | undefined> {
        const result = await this.executor(tx).query<MediaSessionRow>(
            `UPDATE public.media_sessions SET status = 'STARTING'
                 WHERE id = $1 AND room_id = $2 AND status = 'CREATED'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId, roomId],
        );
        return toSession(result.rows[0]);
    }

    /** Guarded STARTING -> ACTIVE transition. */
    async markSessionActive(
        tx: Tx,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession | undefined> {
        const result = await this.executor(tx).query<MediaSessionRow>(
            `UPDATE public.media_sessions
                 SET status = 'ACTIVE', started_at = COALESCE(started_at, NOW())
                 WHERE id = $1 AND room_id = $2 AND status = 'STARTING'
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId, roomId],
        );
        return toSession(result.rows[0]);
    }

    /** Guarded CREATED/STARTING/ACTIVE -> ENDING transition. */
    async markSessionEnding(
        tx: Tx,
        mediaSessionId: string,
    ): Promise<MediaSession | undefined> {
        const result = await this.executor(tx).query<MediaSessionRow>(
            `UPDATE public.media_sessions
                 SET status = 'ENDING'
                 WHERE id = $1 AND status IN ('CREATED', 'STARTING', 'ACTIVE')
                 RETURNING id, room_id, status, assigned_sfu_node_id, created_at, started_at, ended_at`,
            [mediaSessionId],
        );
        return toSession(result.rows[0]);
    }

    /** Enqueues a LIVEKIT_SESSION_RECONCILE event delayed past the startup window. */
    enqueueDelayedSessionReconcile(
        tx: Tx,
        mediaSessionId: string,
    ): Promise<void> {
        return this.events.enqueueDelayedSessionReconcile(
            this.executor(tx),
            mediaSessionId,
        );
    }

    /** Enqueues an immediately due LIVEKIT_SESSION_RECONCILE event. */
    enqueueSessionReconcile(tx: Tx, mediaSessionId: string): Promise<void> {
        return this.events.enqueueSessionReconcile(
            this.executor(tx),
            mediaSessionId,
        );
    }
}
