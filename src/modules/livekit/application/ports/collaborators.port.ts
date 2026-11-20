/*
 * What the media-session use cases need from outside the module.
 * Bindings: infrastructure/livekit.bindings.ts.
 */

/**
 * Rooms and memberships, owned by watch-party. Row shapes are the ones its
 * contract (watch-party/queries/room-access.query.ts) returns.
 * Adapter: RoomAccessQuery.
 */
export interface RoomAccessPort {
    findRoomActivity(
        roomId: string,
    ): Promise<{ id: string; is_active: boolean } | undefined>;
    findActiveMembershipId(
        roomId: string,
        userId: string,
    ): Promise<string | undefined>;
    isRoomActive(roomId: string): Promise<boolean>;
    findActiveRoomId(roomId: string): Promise<string | undefined>;
    findActiveParticipant(
        roomId: string,
        userId: string,
    ): Promise<{ participant_id: string } | undefined>;
    findActiveRoom(
        roomId: string,
    ): Promise<{ id: string; max_participants: number } | undefined>;
}

/**
 * The LiveKit server's room API. Room names are media-session ids.
 * "Not found" from the provider is absorbed here, never thrown.
 * Adapter: infrastructure/provider/livekit-provider.adapter.ts.
 */
export interface MediaProviderPort {
    createRoom(roomName: string, maxParticipants: number): Promise<void>;
    /** Deletes the room; a room that is already gone is not an error. */
    deleteRoomIfPresent(roomName: string): Promise<void>;
    /** Identities in the room, or null when the room does not exist. */
    listParticipantIdentities(roomName: string): Promise<string[] | null>;
    /** Removes a participant; false when it was already gone. */
    removeParticipantIfPresent(
        roomName: string,
        identity: string,
    ): Promise<boolean>;
}

export interface ParticipantTokenRequest {
    roomName: string;
    participantIdentity: string;
    ttl: string;
    canPublish: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
}

/**
 * Signs LiveKit access tokens and knows the URL clients connect to.
 * Adapter: infrastructure/provider/livekit-token.adapter.ts.
 */
export interface ParticipantTokenPort {
    readonly serverUrl: string;
    createParticipantToken(request: ParticipantTokenRequest): Promise<string>;
}

/** Nest's Logger satisfies this; the use cases depend on the shape only. */
export interface LiveKitLogger {
    log(message: unknown): void;
    warn(message: unknown): void;
    error(message: unknown): void;
    debug(message: unknown): void;
}
