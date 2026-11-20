import type { PostgresProvider } from "../../src/shared/infrastructure/database/postgres.provider.js";
import type { RoomAccessQuery } from "../../src/modules/watch-party/queries/room-access.query.js";
import type { MediaSessionEvents } from "../../src/modules/watch-party/queries/media-session-events.js";
import { LiveKitService } from "../../src/modules/livekit/livekit.service.js";
import { LiveKitRepository } from "../../src/modules/livekit/livekit.repository.js";
import { MediaSessionService } from "../../src/modules/livekit/media-session.service.js";
import { MediaSessionRepository } from "../../src/modules/livekit/media-session.repository.js";
import type { LiveKitTokenService } from "../../src/shared/infrastructure/livekit/livekit.token.service.js";
import type { LiveKitInfrastructureService } from "../../src/shared/infrastructure/livekit/livekit.infrastructure.service.js";

/*
 * Builds the LiveKit media-session service for the characterization tests
 * (livekit.service.int-spec.ts) against real Postgres and a recording fake
 * LiveKit server. Only this file knows the constructor wiring, so the tests
 * stay unchanged while the module is restructured.
 */

type ProviderMethod =
    | "createRoom"
    | "deleteRoom"
    | "listParticipants"
    | "removeParticipant";

export class FakeProvider {
    readonly calls: string[][] = [];
    participants: string[] = [];
    private readonly failures = new Map<ProviderMethod, unknown[]>();

    /** The next call to `method` throws `error` (queued, one per call). */
    fail(method: ProviderMethod, error: unknown) {
        const queue = this.failures.get(method) ?? [];
        queue.push(error);
        this.failures.set(method, queue);
    }

    private record(method: ProviderMethod, ...args: (string | number)[]) {
        this.calls.push([method, ...args.map(String)]);
        const queue = this.failures.get(method);
        if (queue?.length) throw queue.shift();
    }

    createRoom(roomName: string, maxParticipants: number) {
        this.record("createRoom", roomName, maxParticipants);
        return Promise.resolve({ name: roomName });
    }

    deleteRoom(roomName: string) {
        this.record("deleteRoom", roomName);
        return Promise.resolve();
    }

    listParticipants(roomName: string) {
        this.record("listParticipants", roomName);
        return Promise.resolve(
            this.participants.map((identity) => ({ identity })),
        );
    }

    removeParticipant(roomName: string, identity: string) {
        this.record("removeParticipant", roomName, identity);
        return Promise.resolve();
    }
}

export class FakeTokens {
    readonly issued: Record<string, unknown>[] = [];

    createParticipantToken(options: {
        participantIdentity: string;
        [key: string]: unknown;
    }) {
        this.issued.push(options);
        return Promise.resolve(`token-for-${options.participantIdentity}`);
    }
}

export const TEST_LIVEKIT_URL = "wss://livekit.test";

export function buildLiveKit(deps: {
    pg: PostgresProvider;
    rooms: RoomAccessQuery;
    events: MediaSessionEvents;
}) {
    const provider = new FakeProvider();
    const tokens = new FakeTokens();
    const mediaRepository = new MediaSessionRepository(deps.pg, deps.rooms);
    const service = new LiveKitService(
        new LiveKitRepository(deps.pg, deps.rooms, deps.events),
        new MediaSessionService(mediaRepository),
        tokens as unknown as LiveKitTokenService,
        provider as unknown as LiveKitInfrastructureService,
        { url: TEST_LIVEKIT_URL, apiKey: "test-key", apiSecret: "test-secret" },
    );

    return {
        service,
        provider,
        tokens,
        /**
         * Two requests racing: the first lookup and the pre-insert check both
         * miss the session the other request just created, so the INSERT hits
         * the unique index. Later lookups see the winner.
         */
        hideOpenSessionFromCreateCheck() {
            jest.spyOn(
                mediaRepository,
                "findLatestOpenSessionByRoomId",
            ).mockResolvedValueOnce(undefined);
            jest.spyOn(
                mediaRepository,
                "findAnyOpenSessionByRoomId",
            ).mockResolvedValue(undefined);
        },
    };
}
