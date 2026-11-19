import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type {
    MediaSessionRow,
    RoomActivityRow,
    RoomParticipantRow,
    SfuNodeAssignmentRow,
    SfuNodeConnectionRow,
    SfuNodeEndpointRow,
    SfuNodeRow,
} from "./media-session.types.js";
import { RoomAccessQuery } from "../watch-party/queries/room-access.query.js";

/** SQL for `media_sessions` and the SFU node / room lookups around it. */
@Injectable()
export class MediaSessionRepository {
    constructor(
        private readonly pg: PostgresProvider,
        /** Watch-party owns rooms and memberships; read through its contract. */
        private readonly rooms: RoomAccessQuery,
    ) {}

    // ---- rooms / participants ----

    findRoomActivity(roomId: string): Promise<RoomActivityRow | undefined> {
        return this.rooms.findRoomActivity(roomId);
    }

    findRoomParticipant(
        roomId: string,
        userId: string,
    ): Promise<RoomParticipantRow | undefined> {
        return this.rooms.findRoomParticipant(roomId, userId);
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

    /** CREATED → STARTING. Undefined when the session was not CREATED. */
    async markStarting(
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
        const query = `UPDATE public.media_sessions
            SET
                status = 'STARTING'
            WHERE id = $1
              AND status = 'CREATED'
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at`;

        const result = await this.pg.query<MediaSessionRow>(query, [
            mediaSessionId,
        ]);
        return result.rows[0];
    }

    /** STARTING → ACTIVE. Undefined when the session was not STARTING. */
    async markActive(
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ACTIVE',
                started_at = COALESCE(started_at, NOW())
            WHERE id = $1
              AND status = 'STARTING'
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

    /** CREATED/STARTING/ACTIVE → ENDING. Undefined otherwise. */
    async markEnding(
        mediaSessionId: string,
    ): Promise<MediaSessionRow | undefined> {
        const query = `
            UPDATE public.media_sessions
            SET
                status = 'ENDING'
            WHERE id = $1
              AND status IN (
                  'CREATED',
                  'STARTING',
                  'ACTIVE'
              )
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

    /** Sets `assigned_sfu_node_id` (the sfu_nodes primary key, not node_id). */
    async setAssignedSfuNode(
        mediaSessionId: string,
        sfuNodePk: string,
    ): Promise<MediaSessionRow | undefined> {
        const updateQuery = `
            UPDATE public.media_sessions
            SET assigned_sfu_node_id = $1
            WHERE id = $2
            RETURNING
                id,
                room_id,
                status,
                assigned_sfu_node_id,
                created_at,
                started_at,
                ended_at
        `;

        const result = await this.pg.query<MediaSessionRow>(updateQuery, [
            sfuNodePk,
            mediaSessionId,
        ]);
        return result.rows[0];
    }

    // ---- sfu_nodes ----

    async findSfuNodeByNodeId(
        sfuNodeId: string,
    ): Promise<SfuNodeAssignmentRow | undefined> {
        const nodeQuery = `
            SELECT
                id,
                node_id,
                status
            FROM public.sfu_nodes
            WHERE node_id = $1
            LIMIT 1
        `;

        const result = await this.pg.query<SfuNodeAssignmentRow>(nodeQuery, [
            sfuNodeId,
        ]);
        return result.rows[0];
    }

    async findSfuNodeConnectionById(
        sfuNodePk: string,
    ): Promise<SfuNodeConnectionRow | undefined> {
        const nodeQuery = `
            SELECT
                id,
                node_id,
                endpoint,
                signaling_endpoint,
                status
            FROM public.sfu_nodes
            WHERE id = $1
            LIMIT 1
        `;

        const result = await this.pg.query<SfuNodeConnectionRow>(nodeQuery, [
            sfuNodePk,
        ]);
        return result.rows[0];
    }

    async findSfuNodeEndpointById(
        sfuNodePk: string,
    ): Promise<SfuNodeEndpointRow | undefined> {
        const nodeQuery = `
            SELECT
                id,
                node_id,
                endpoint,
                status
            FROM public.sfu_nodes
            WHERE id = $1
            LIMIT 1
        `;

        const result = await this.pg.query<SfuNodeEndpointRow>(nodeQuery, [
            sfuNodePk,
        ]);
        return result.rows[0];
    }

    /** Best available node: HEALTHY first, then capacity, then freshest heartbeat. */
    async findBestAvailableSfuNode(): Promise<SfuNodeRow | undefined> {
        const query = `
            SELECT
                id,
                node_id,
                endpoint,
                signaling_endpoint,
                status,
                capacity,
                last_heartbeat_at
            FROM public.sfu_nodes
            WHERE status IN ('HEALTHY', 'DEGRADED')
            ORDER BY
                CASE
                    WHEN status = 'HEALTHY' THEN 0
                    ELSE 1
                END,
                capacity DESC,
                last_heartbeat_at DESC NULLS LAST
            LIMIT 1
        `;

        const result = await this.pg.query<SfuNodeRow>(query);
        return result.rows[0];
    }
}
