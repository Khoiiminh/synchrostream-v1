/*
 * LiveKit's published contract for other modules (watch-party binds its
 * MediaSessionPort to it). Pure types and a token: importing this file pulls
 * in nothing else of the livekit module.
 */

export interface MediaSessionSummary {
    id: string;
    roomId: string;
    status: string;
}

export interface LiveKitMediaSessions {
    /** Starts (or returns) the room's ACTIVE session. */
    getOrCreateMediaSession(roomId: string): Promise<MediaSessionSummary>;
    /** Converges one session after a LIVEKIT_SESSION_RECONCILE event. */
    reconcileMediaSession(
        mediaSessionId: string,
        recoveryStartedAt: Date | string,
    ): Promise<void>;
    /** Ends the room's open session, if any. */
    endMediaSessionForRoom(roomId: string): Promise<void>;
    /** Removes provider participants whose identity is not allowed. */
    reconcileRoomParticipants(
        roomId: string,
        loadAllowedIdentities: () => Promise<ReadonlySet<string>>,
    ): Promise<void>;
}

export const LIVEKIT_MEDIA_SESSIONS = Symbol("LIVEKIT_MEDIA_SESSIONS");
