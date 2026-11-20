import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import { AttemptLimiter } from "@/shared/infrastructure/cache/attempt-limiter.js";
import { LiveKitService } from "../livekit/livekit.service.js";
import { WatchPartyModule } from "./watch-party.module.js";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { RoomLifecycleOutboxService } from "./infrastructure/outbox/room-lifecycle-outbox.service.js";
import { RoomChatRelay } from "./room-chat.relay.js";
import { WatchPartyRepository } from "./infrastructure/persistence/watch-party.repository.js";
import { RoomChatRepository } from "./infrastructure/persistence/room-chat.repository.js";
import { BcryptPasswordHasher } from "./infrastructure/security/bcrypt-password-hasher.js";
import { RoomAccessQuery } from "./queries/room-access.query.js";
import { MediaSessionEvents } from "./queries/media-session-events.js";
import { LiveKitRepository } from "../livekit/livekit.repository.js";
import { MediaSessionRepository } from "../livekit/media-session.repository.js";
import {
    ATTEMPT_LIMITER,
    CHAT_STORE,
    LIFECYCLE_OUTBOX,
    MEDIA_SESSION,
    PASSWORD_HASHER,
    REALTIME_STATE,
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
        const bound = moduleRef.get<unknown>(token, { strict: false });
        expect(bound).toBeInstanceOf(adapter);
        expect(bound).toBe(moduleRef.get<unknown>(adapter, { strict: false }));
    });

    it("the facade's use cases receive the bound ports", () => {
        // Since phase 3 WatchPartyService builds the use cases from its ports.
        const service = moduleRef.get<
            WatchPartyService,
            Record<string, Record<string, unknown>>
        >(WatchPartyService);
        const store = moduleRef.get<unknown>(WATCH_PARTY_STORE);
        const outbox = moduleRef.get<unknown>(LIFECYCLE_OUTBOX);
        for (const useCase of [
            "createRoom",
            "joinRoom",
            "leaveRoom",
            "expireMembership",
        ]) {
            expect(service[useCase].repo).toBe(store);
            expect(service[useCase].lifecycleOutbox).toBe(outbox);
        }
        expect(service.queries.repo).toBe(store);
        expect(service.joinRoom.attemptLimiter).toBe(
            moduleRef.get(ATTEMPT_LIMITER, { strict: false }),
        );
        expect(service.createRoom.passwords).toBe(
            moduleRef.get(PASSWORD_HASHER),
        );
        expect(service.joinRoom.passwords).toBe(moduleRef.get(PASSWORD_HASHER));
    });

    it("the outbox and chat relay receive their ports", () => {
        // Since phase 3 the outbox worker builds its use cases from the ports.
        const outbox = moduleRef.get<
            RoomLifecycleOutboxService,
            Record<string, Record<string, unknown>>
        >(RoomLifecycleOutboxService);
        const projection = moduleRef.get<unknown>(ROOM_STATE_PROJECTION, {
            strict: false,
        });
        const media = moduleRef.get<unknown>(MEDIA_SESSION, { strict: false });
        expect(outbox.reconcileRoom.redis).toBe(projection);
        expect(outbox.reconcileRoom.liveKit).toBe(media);
        expect(outbox.processEvent.liveKit).toBe(media);
        expect(outbox.processEvent.reconcileRoom).toBe(outbox.reconcileRoom);

        const relay = moduleRef.get<RoomChatRelay, Record<string, unknown>>(
            RoomChatRelay,
        );
        expect(relay.repository).toBe(moduleRef.get(CHAT_STORE));
    });

    it("LiveKit and media sessions reach watch-party tables only through its contract", () => {
        const rooms = moduleRef.get(RoomAccessQuery, { strict: false });
        const events = moduleRef.get(MediaSessionEvents, { strict: false });
        const liveKitRepo = moduleRef.get<
            LiveKitRepository,
            Record<string, unknown>
        >(LiveKitRepository, { strict: false });
        const mediaRepo = moduleRef.get<
            MediaSessionRepository,
            Record<string, unknown>
        >(MediaSessionRepository, { strict: false });
        expect(rooms).toBeInstanceOf(RoomAccessQuery);
        expect(liveKitRepo.rooms).toBe(rooms);
        expect(liveKitRepo.events).toBe(events);
        expect(mediaRepo.rooms).toBe(rooms);
    });

    it("the gateway's realtime collaborators share one context with the bound ports", () => {
        const gateway = moduleRef.get<
            WatchPartyGateway,
            Record<string, { ctx: Record<string, unknown> }>
        >(WatchPartyGateway);
        expect(gateway).toBeInstanceOf(WatchPartyGateway);

        const ctx = gateway.lifecycle.ctx;
        expect(ctx.redis).toBe(
            moduleRef.get(REALTIME_STATE, { strict: false }),
        );
        expect(ctx.redis).toBeInstanceOf(RedisProvider);
        expect(ctx.liveKitService).toBe(
            moduleRef.get(MEDIA_SESSION, { strict: false }),
        );
        expect(ctx.watchPartyService).toBe(moduleRef.get(WatchPartyService));
        expect(ctx.chatRelay).toBe(moduleRef.get(RoomChatRelay));
        for (const part of ["handshake", "playback", "chat"]) {
            expect(gateway[part].ctx).toBe(ctx);
        }
        for (const part of ["lifecycle", "media", "chat", "playback"]) {
            expect(ctx[part]).toBeDefined();
        }
    });
});
