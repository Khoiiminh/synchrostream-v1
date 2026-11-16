/**
 * Row shapes returned by the watch-party SQL queries. Column names match the
 * SELECT / RETURNING lists (snake_case unless the query aliases them).
 * `state_version` is a BIGINT, which node-postgres returns as a string.
 */

export type RoomLifecycleStatus =
    | "PROVISIONING"
    | "ACTIVE"
    | "TERMINATING"
    | "TERMINATED";

export interface CreatedRoomRow {
    id: string;
    room_code: string;
    owner_id: string;
    movie_id: string;
    max_participants: number;
    state_version: string;
}

export interface LockedRoomRow extends CreatedRoomRow {
    /** bcrypt hash of the room password. Required at room creation, so never NULL. */
    password: string;
    lifecycle_status: RoomLifecycleStatus;
}

export interface ParticipantRow {
    id: string;
    room_id: string;
    user_id: string;
    has_control_privilege: boolean;
}

export interface CountRow {
    count: number;
}

export interface StateVersionRow {
    state_version: string;
}

export interface RoomStatusRow {
    id: string;
    room_code: string;
    lifecycle_status: RoomLifecycleStatus;
}

export interface UserSessionRow {
    room_id: string;
    room_code: string;
    owner_id: string;
    /** NULL when the user owns the room but has no active participant record. */
    participant_id: string | null;
}

export interface InactiveRoomRow {
    room_id: string;
    room_code: string;
    owner_id: string;
    lifecycle_status: RoomLifecycleStatus;
}

export interface MemberUserRow {
    user_id: string;
}

/** `getRoomDetailsByCode` result (columns aliased to camelCase in SQL). */
export interface RoomDetails {
    roomId: string;
    roomCode: string;
    ownerId: string;
    movieId: string;
    maxParticipants: number;
    isActive: boolean;
    lifecycleStatus: RoomLifecycleStatus;
}

export interface ActiveMembershipRow {
    participant_id: string;
    room_id: string;
    user_id: string;
    room_code: string;
    owner_id: string;
}

export interface RoomProjectionRow {
    id: string;
    room_code: string;
    owner_id: string;
    movie_id: string;
    max_participants: number;
    lifecycle_status: RoomLifecycleStatus;
    state_version: string;
    participant_count: number;
}

/** An owner's existing PROVISIONING/ACTIVE room (room-creation guard). */
export interface OwnedRoomRow {
    id: string;
    room_code: string;
}

export interface MembershipRoomRow {
    room_id: string;
}

export interface IdRow {
    id: string;
}

/** `findCurrentRoom` result row. */
export interface CurrentRoomRow {
    id: string;
    room_code: string;
    is_owner: boolean;
}

/** Owner of a Redis room-code key, as recorded in PostgreSQL. */
export interface RoomCodeHolderRow {
    room_code: string;
    lifecycle_status: RoomLifecycleStatus;
}

export interface OutboxEvent {
    event_id: string;
    event_type: "ROOM_RECONCILE" | "LIVEKIT_SESSION_RECONCILE";
    aggregate_id: string;
    attempts: number;
    created_at: Date;
}
