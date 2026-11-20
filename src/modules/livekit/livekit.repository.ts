import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    SqlExecutor,
    TransactionClient,
} from "@/shared/infrastructure/database/sql-executor.js";
import type { MediaSessionRow } from "./media-session.types.js";
import type { ActiveParticipantRow, ActiveRoomRow } from "./livekit.types.js";
import { RoomAccessQuery } from "../watch-party/queries/room-access.query.js";
import { MediaSessionEvents } from "../watch-party/queries/media-session-events.js";

/**
 * LiveKit persistence: the guarded `media_sessions` status transitions. Room
 * and membership checks and outbox events go through watch-party's contract
 * (watch-party/queries), which owns those tables.
 *
 * Note: SQL text inside template literals is kept byte-for-byte identical to
 * the original service implementation, including continuation-line indentation.
 */
@Injectable()
export class LiveKitRepository {
    constructor(
        private readonly pg: PostgresProvider,
        /** Watch-party owns rooms and memberships; LiveKit reads them through its contract. */
        private readonly rooms: RoomAccessQuery,
        /** Watch-party owns the lifecycle outbox; LiveKit enqueues through its contract. */
        private readonly events: MediaSessionEvents,
    ) {}

    withTransaction<T>(cb: (tx: TransactionClient) => Promise<T>): Promise<T> {
        return this.pg.withTransaction(cb);
    }

    /** Membership id of an active member of an ACTIVE room, if any. */
    findActiveMembershipId(
        roomId: string,
        userId: string,
    ): Promise<string | undefined> {
        return this.rooms.findActiveMembershipId(roomId, userId);
    }

    /** Whether the room exists and is ACTIVE (`SELECT 1` probe). */
    isRoomActive(roomId: string): Promise<boolean> {
        return this.rooms.isRoomActive(roomId);
    }

    /** Id of the room if it exists and is ACTIVE. */
    findActiveRoomId(roomId: string): Promise<string | undefined> {
        return this.rooms.findActiveRoomId(roomId);
    }

    /** The active participant row for a user in an ACTIVE room, if any. */
    findActiveParticipant(
        roomId: string,
        userId: string,
    ): Promise<ActiveParticipantRow | undefined> {
        return this.rooms.findActiveParticipant(roomId, userId);
    }

    /** The ACTIVE room with its capacity, if it exists. */
    findActiveRoom(roomId: string): Promise<ActiveRoomRow | undefined> {
        return this.rooms.findActiveRoom(roomId);
    }

    /** Locks the room row `FOR UPDATE` if ACTIVE; returns whether it was found. */
    lockActiveRoom(db: SqlExecutor, roomId: string): Promise<boolean> {
        return this.rooms.lockActiveRoom(db, roomId);
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
    enqueueDelayedSessionReconcile(
        db: SqlExecutor,
        mediaSessionId: string,
    ): Promise<void> {
        return this.events.enqueueDelayedSessionReconcile(db, mediaSessionId);
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
    enqueueSessionReconcile(
        db: SqlExecutor,
        mediaSessionId: string,
    ): Promise<void> {
        return this.events.enqueueSessionReconcile(db, mediaSessionId);
    }
}
