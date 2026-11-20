import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    MediaSessionRow,
    RoomActivityRow,
} from "./media-session.types.js";
import { RoomAccessQuery } from "../watch-party/queries/room-access.query.js";

/**
 * SQL for the `media_sessions` lifecycle rows: create, read and complete.
 * The guarded LiveKit start/activate/end transitions are in LiveKitRepository.
 */
@Injectable()
export class MediaSessionRepository {
    constructor(
        private readonly pg: PostgresProvider,
        /** Watch-party owns rooms and memberships; read through its contract. */
        private readonly rooms: RoomAccessQuery,
    ) {}

    // ---- rooms ----

    findRoomActivity(roomId: string): Promise<RoomActivityRow | undefined> {
        return this.rooms.findRoomActivity(roomId);
    }

    // ---- media_sessions reads ----

    /** Any CREATED/STARTING/ACTIVE/ENDING session of the room (unordered). */
    async findAnyOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSessionRow | undefined> {
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
        return result.rows[0];
    }

    async findById(
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
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
        return result.rows[0];
    }

    /** Newest CREATED/STARTING/ACTIVE/ENDING session of the room. */
    async findLatestOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSessionRow | undefined> {
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
        return result.rows[0];
    }

    // ---- media_sessions writes ----

    /**
     * Inserts a CREATED session only while the room is ACTIVE, holding a share
     * lock on the room row. Returns undefined when the room is not ACTIVE.
     */
    async insertCreatedSessionIfRoomActive(
        roomId: string,
    ): Promise<MediaSessionRow | undefined> {
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

        const result = await this.pg.query<MediaSessionRow>(insertQuery, [
            roomId,
        ]);
        return result.rows[0];
    }

    /** ENDING → ENDED. Undefined when the session was not ENDING. */
    async markEnded(
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
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
        return result.rows[0];
    }
}
