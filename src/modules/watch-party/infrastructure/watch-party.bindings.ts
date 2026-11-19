import type { Provider } from "@nestjs/common";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { AttemptLimiter } from "@/shared/infrastructure/cache/attempt-limiter.js";
import { LiveKitService } from "../../livekit/livekit.service.js";
import { RoomLifecycleOutboxService } from "../room-lifecycle-outbox.service.js";
import { WatchPartyRepository } from "./persistence/watch-party.repository.js";
import { RoomChatRepository } from "./persistence/room-chat.repository.js";
import { BcryptPasswordHasher } from "./security/bcrypt-password-hasher.js";
import type {
    AttemptLimiterPort,
    MediaSessionPort,
    RoomStateProjectionPort,
} from "../application/ports/collaborators.port.js";
import {
    ATTEMPT_LIMITER,
    CHAT_STORE,
    LIFECYCLE_OUTBOX,
    MEDIA_SESSION,
    PASSWORD_HASHER,
    ROOM_STATE_PROJECTION,
    WATCH_PARTY_STORE,
} from "../application/ports/tokens.js";

/*
 * Port → adapter. The shared classes below were not written against these
 * ports, so this file is where their fit is checked: if a signature drifts,
 * the assignments fail to compile here, not at runtime.
 */
type Implements<Port, Adapter extends Port> = Adapter;
export type AdapterChecks = [
    Implements<RoomStateProjectionPort, RedisProvider>,
    Implements<MediaSessionPort, LiveKitService>,
    Implements<AttemptLimiterPort, AttemptLimiter>,
];

export const WATCH_PARTY_PORT_BINDINGS: Provider[] = [
    BcryptPasswordHasher,
    { provide: WATCH_PARTY_STORE, useExisting: WatchPartyRepository },
    { provide: CHAT_STORE, useExisting: RoomChatRepository },
    { provide: PASSWORD_HASHER, useExisting: BcryptPasswordHasher },
    { provide: ATTEMPT_LIMITER, useExisting: AttemptLimiter },
    { provide: LIFECYCLE_OUTBOX, useExisting: RoomLifecycleOutboxService },
    { provide: MEDIA_SESSION, useExisting: LiveKitService },
    { provide: ROOM_STATE_PROJECTION, useExisting: RedisProvider },
];
