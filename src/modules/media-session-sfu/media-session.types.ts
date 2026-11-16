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

export type SfuNodeStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

/** `public.rooms` columns read before creating a media session. */
export interface RoomActivityRow {
    id: string;
    is_active: boolean;
}

/** `public.sfu_nodes` columns read when assigning a node to a session. */
export interface SfuNodeAssignmentRow {
    id: string;
    node_id: string;
    status: SfuNodeStatus;
}

/** `public.room_participants` columns read when issuing a connection. */
export interface RoomParticipantRow {
    participant_id: string;
    user_id: string;
    room_id: string;
}

/** `public.sfu_nodes` columns read when issuing a connection. */
export interface SfuNodeConnectionRow {
    id: string;
    node_id: string;
    endpoint: string;
    signaling_endpoint: string;
    status: SfuNodeStatus;
}

/** `public.sfu_nodes` columns read when ending a session on its node. */
export interface SfuNodeEndpointRow {
    id: string;
    node_id: string;
    endpoint: string;
    status: SfuNodeStatus;
}

/** Full `public.sfu_nodes` row as read by node selection. */
export interface SfuNodeRow {
    id: string;
    node_id: string;
    endpoint: string;
    signaling_endpoint: string;
    status: SfuNodeStatus;
    capacity: number;
    last_heartbeat_at: Date | null;
}
