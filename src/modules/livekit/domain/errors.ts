/*
 * Media-session errors. Each kind maps to one HTTP status at the
 * presentation boundary (presentation/error-mapper.ts); the message is
 * what clients see.
 */

export type LiveKitErrorKind = "NOT_FOUND" | "CONFLICT" | "FORBIDDEN";

export abstract class LiveKitDomainError extends Error {
    abstract readonly kind: LiveKitErrorKind;
}

/** A session, room or membership the operation needs does not exist. */
export class MediaNotFound extends LiveKitDomainError {
    readonly kind = "NOT_FOUND" as const;
}

/** The session or room is in a state that does not allow the operation. */
export class MediaConflict extends LiveKitDomainError {
    readonly kind = "CONFLICT" as const;
}

/** The caller may not perform the operation. */
export class MediaForbidden extends LiveKitDomainError {
    readonly kind = "FORBIDDEN" as const;
}

export const MESSAGES = {
    sessionNotFound: "The requested media session does not exist.",
    roomHasNoSession:
        "The requested watch room does not have an active media session.",
    roomNotFound: "The requested watch room does not exist.",
    roomInactive: "Cannot create a media session for an inactive room.",
    roomAlreadyHasSession: "The room already has an active media session.",
    cannotComplete:
        "MediaSession cannot transition to ENDED from its current state.",
    stillStarting:
        "The room's LiveKit media session is still starting. Retry the connection shortly.",
    recoveryExhausted:
        "Unable to establish a LiveKit media session after several recovery attempts.",
    notActiveMember:
        "Only active members of an active room can start its media session.",
    stillInRecoveryWindow:
        "LiveKit startup is still within its recovery window.",
    cannotTerminate: (status: string) =>
        `Cannot terminate LiveKit media session from status ${status}.`,
    cannotConnect: (status: string) =>
        `MediaSession cannot be connected from status ${status}.`,
    notParticipant:
        "The authenticated user is not a participant of the MediaSession room.",
    cannotStart: (status: string) =>
        `MediaSession cannot start from status ${status}.`,
    startRoomMissing:
        "The MediaSession watch room does not exist or is inactive.",
    roomNotAcceptingMedia:
        "The watch room is no longer accepting media connections.",
    startRoomNotActive:
        "Cannot start LiveKit for a room that is no longer ACTIVE.",
    changedBeforeStartup: "MediaSession state changed before LiveKit startup.",
    terminatingBeforeActivation:
        "The watch room began termination before LiveKit activation.",
    cannotActivate: "MediaSession cannot activate from its current state.",
    changedBeforeTermination:
        "MediaSession state changed before LiveKit termination.",
} as const;
