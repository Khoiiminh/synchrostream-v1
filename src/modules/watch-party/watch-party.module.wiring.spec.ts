import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { AttemptLimiter } from "@/shared/infrastructure/cache/attempt-limiter.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import { WatchPartyModule } from "./watch-party.module.js";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { RoomLifecycleOutboxService } from "./room-lifecycle-outbox.service.js";
import { RoomChatRelay } from "./room-chat.relay.js";
import { WatchPartyRepository } from "./infrastructure/persistence/watch-party.repository.js";
import { RoomChatRepository } from "./infrastructure/persistence/room-chat.repository.js";
import { BcryptPasswordHasher } from "./infrastructure/security/bcrypt-password-hasher.js";
import {
    ATTEMPT_LIMITER,
    CHAT_STORE,
    LIFECYCLE_OUTBOX,
    MEDIA_SESSION,
    PASSWORD_HASHER,
    ROOM_STATE_PROJECTION,
    WATCH_PARTY_STORE,
} from "./application/ports/tokens.js";

/*
 * Boots the real WatchPartyModule's dependency graph (compile only: no
 * onModuleInit, so no database, Redis or LiveKit connection is opened) and
 * checks every port token resolves to its intended adapter, and that the
 * classes using the ports received exactly those instances.
 */

// AuthModule → auth.service imports maskEmail from the app logger, which uses
// import.meta (ESM-only). The logger is not under test; stub it.
jest.mock("../../common/logging/logger.js", () => ({
    maskEmail: (email: string) => email,
}));

let moduleRef: TestingModule;

beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    // Read by providers' constructors/factories; dummy values, never used to connect.
    process.env.JWT_SECRET ??= "wiring-test-secret";
    process.env.LIVEKIT_URL ??= "ws://127.0.0.1:1";
    process.env.LIVEKIT_API_KEY ??= "wiring-test";
    process.env.LIVEKIT_API_SECRET ??= "wiring-test-secret-wiring-test-secret";

    moduleRef = await Test.createTestingModule({
        imports: [
            // As AppModule does, but never reading an env file.
            ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
            WatchPartyModule,
        ],
    }).compile();
});

describe("WatchPartyModule wiring", () => {
    it.each([
        ["WATCH_PARTY_STORE", WATCH_PARTY_STORE, WatchPartyRepository],
        ["CHAT_STORE", CHAT_STORE, RoomChatRepository],
        ["PASSWORD_HASHER", PASSWORD_HASHER, BcryptPasswordHasher],
        ["ATTEMPT_LIMITER", ATTEMPT_LIMITER, AttemptLimiter],
        ["LIFECYCLE_OUTBOX", LIFECYCLE_OUTBOX, RoomLifecycleOutboxService],
        ["MEDIA_SESSION", MEDIA_SESSION, LiveKitService],
        ["ROOM_STATE_PROJECTION", ROOM_STATE_PROJECTION, RedisProvider],
    ] as const)("%s → the singleton %p", (_name, token, adapter) => {
        const bound = moduleRef.get(token, { strict: false });
        expect(bound).toBeInstanceOf(adapter);
        expect(bound).toBe(moduleRef.get(adapter as never, { strict: false }));
    });

    it("WatchPartyService receives the bound ports", () => {
        const service = moduleRef.get(WatchPartyService) as unknown as Record<string, unknown>;
        expect(service.repo).toBe(moduleRef.get(WATCH_PARTY_STORE));
        expect(service.lifecycleOutbox).toBe(moduleRef.get(LIFECYCLE_OUTBOX));
        expect(service.attemptLimiter).toBe(moduleRef.get(ATTEMPT_LIMITER, { strict: false }));
        expect(service.passwords).toBe(moduleRef.get(PASSWORD_HASHER));
    });

    it("the outbox and chat relay receive their ports", () => {
        const outbox = moduleRef.get(RoomLifecycleOutboxService) as unknown as Record<string, unknown>;
        expect(outbox.redis).toBe(moduleRef.get(ROOM_STATE_PROJECTION, { strict: false }));
        expect(outbox.liveKit).toBe(moduleRef.get(MEDIA_SESSION, { strict: false }));

        const relay = moduleRef.get(RoomChatRelay) as unknown as Record<string, unknown>;
        expect(relay.repository).toBe(moduleRef.get(CHAT_STORE));
    });

    it("the gateway resolves", () => {
        expect(moduleRef.get(WatchPartyGateway)).toBeInstanceOf(WatchPartyGateway);
    });
});
