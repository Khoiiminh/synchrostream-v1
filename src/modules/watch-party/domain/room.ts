/*
 * Room lifecycle, as enforced by the SQL today (watch-party.repository.ts and
 * room-lifecycle-outbox.repository.ts) and the `room_lifecycle_status` enum:
 *
 *   PROVISIONING ──▶ ACTIVE ──▶ TERMINATING ──▶ TERMINATED
 *        └──────────────────────────▲
 *
 * - PROVISIONING → ACTIVE       the outbox finished provisioning
 * - PROVISIONING → TERMINATING  provisioning timed out, or the owner left first
 * - ACTIVE → TERMINATING        owner left or the owner's grace expired
 * - TERMINATING → TERMINATED    the outbox finished provider/projection cleanup
 */

export const ROOM_LIFECYCLE_STATUSES = [
    "PROVISIONING",
    "ACTIVE",
    "TERMINATING",
    "TERMINATED",
] as const;

export type RoomLifecycleStatus = (typeof ROOM_LIFECYCLE_STATUSES)[number];

export const ROOM_LIFECYCLE_TRANSITIONS: Readonly<
    Record<RoomLifecycleStatus, readonly RoomLifecycleStatus[]>
> = {
    PROVISIONING: ["ACTIVE", "TERMINATING"],
    ACTIVE: ["TERMINATING"],
    TERMINATING: ["TERMINATED"],
    TERMINATED: [],
};

export function canTransition(
    from: RoomLifecycleStatus,
    to: RoomLifecycleStatus,
): boolean {
    return ROOM_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Live: the room blocks its owner and members from another live room. */
export function isLiveRoom(status: string): boolean {
    return status === "PROVISIONING" || status === "ACTIVE";
}

/** Only an ACTIVE room admits, keeps and syncs participants. */
export function acceptsParticipants(status: string): boolean {
    return status === "ACTIVE";
}

/** Shutting down or shut down: cleanup may still need finishing. */
export function isShuttingDown(status: string): boolean {
    return status === "TERMINATING" || status === "TERMINATED";
}

/** The room code stays reserved until the room is fully TERMINATED. */
export function reservesRoomCode(status: string): boolean {
    return status !== "TERMINATED";
}
