export type MediaSessionStatus =
    | "CREATED"
    | "STARTING"
    | "ACTIVE"
    | "ENDING"
    | "ENDED";

export interface MediaSession {
    id: string;
    roomId: string;
    status: MediaSessionStatus;
    assignedSfuNodeId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
}

/** Row shape of `public.media_sessions` as selected/returned by the services. */
export interface MediaSessionRow {
    id: string;
    room_id: string;
    status: MediaSessionStatus;
    assigned_sfu_node_id: string | null;
    created_at: Date;
    started_at: Date | null;
    ended_at: Date | null;
}

export function mapMediaSessionRow(row: MediaSessionRow): MediaSession {
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

/** `public.rooms` columns read before creating a media session. */
export interface RoomActivityRow {
    id: string;
    is_active: boolean;
}
