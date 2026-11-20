/*
 * A media session is one generation of a room's LiveKit room. Its id is
 * also the provider room name, so cleanup of an old generation can never
 * touch its replacement.
 *
 *   CREATED → STARTING → ACTIVE → ENDING → ENDED
 *   CREATED / STARTING → ENDING (abandoned or failed startup)
 */

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

/**
 * How long a STARTING session is given before it counts as crashed. The
 * delayed LIVEKIT_SESSION_RECONCILE event is scheduled just past it.
 */
export const STARTUP_WINDOW_MS = 30_000;

/** Whether a startup that began at `since` is past the startup window. */
export function isPastStartupWindow(
    since: Date | string,
    now: number = Date.now(),
): boolean {
    return now - new Date(since).getTime() >= STARTUP_WINDOW_MS;
}

/**
 * Whether a provider room may exist for a session in this status. A CREATED
 * session never reached the provider, so ending it needs no provider delete.
 */
export function mayHaveProviderRoom(status: MediaSessionStatus): boolean {
    return status === "STARTING" || status === "ACTIVE" || status === "ENDING";
}

/** Statuses from which the guarded ENDING transition is allowed. */
export function canBeginEnding(status: MediaSessionStatus): boolean {
    return status === "CREATED" || status === "STARTING" || status === "ACTIVE";
}

/** Grants for a member's connection token: short-lived, full media rights. */
export const PARTICIPANT_GRANTS = {
    // Only needed to (re)join. Connected clients receive refreshed tokens
    // from LiveKit, while a member whose membership ended cannot reuse an
    // old token for long. Removal from the provider room is enforced by
    // ROOM_RECONCILE.
    ttl: "10m",
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
} as const;
