import type { Provider } from "@nestjs/common";
import { RoomAccessQuery } from "../../watch-party/queries/room-access.query.js";
import { MediaSessionRepository } from "./persistence/media-session.repository.js";
import { LiveKitProviderAdapter } from "./provider/livekit-provider.adapter.js";
import { LiveKitTokenAdapter } from "./provider/livekit-token.adapter.js";
import {
    LIVEKIT_CONFIG_PROVIDER,
    LIVEKIT_ROOM_API_PROVIDER,
} from "./provider/livekit.config.js";
import type {
    MediaProviderPort,
    ParticipantTokenPort,
    RoomAccessPort,
} from "../application/ports/collaborators.port.js";
import type { MediaSessionStore } from "../application/ports/media-session-store.port.js";
import {
    MEDIA_PROVIDER,
    MEDIA_SESSION_STORE,
    PARTICIPANT_TOKENS,
    ROOM_ACCESS,
} from "../application/ports/tokens.js";

/*
 * Port → adapter. RoomAccessQuery belongs to watch-party and was not written
 * against RoomAccessPort, so its fit is checked here at compile time.
 */
type Implements<Port, Adapter extends Port> = Adapter;
export type AdapterChecks = [
    Implements<RoomAccessPort, RoomAccessQuery>,
    Implements<MediaSessionStore, MediaSessionRepository>,
    Implements<MediaProviderPort, LiveKitProviderAdapter>,
    Implements<ParticipantTokenPort, LiveKitTokenAdapter>,
];

export const LIVEKIT_PORT_BINDINGS: Provider[] = [
    LIVEKIT_CONFIG_PROVIDER,
    LIVEKIT_ROOM_API_PROVIDER,
    MediaSessionRepository,
    LiveKitProviderAdapter,
    LiveKitTokenAdapter,
    { provide: MEDIA_SESSION_STORE, useExisting: MediaSessionRepository },
    { provide: ROOM_ACCESS, useExisting: RoomAccessQuery },
    { provide: MEDIA_PROVIDER, useExisting: LiveKitProviderAdapter },
    { provide: PARTICIPANT_TOKENS, useExisting: LiveKitTokenAdapter },
];
