import { HttpException, Logger } from "@nestjs/common";
import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { RoomAccessQuery } from "../watch-party/queries/room-access.query.js";
import { MediaSessionEvents } from "../watch-party/queries/media-session-events.js";
import {
    connectTestPostgres,
    insertMovie,
    insertUser,
    resetDatabase,
    silenceNestLogger,
} from "../../../test/integration/fixtures.js";
import {
    buildLiveKit,
    type FakeProvider,
} from "../../../test/integration/livekit-harness.js";

/*
 * Characterization tests for the LiveKit media-session lifecycle (plan B2),
 * written before the clean-architecture split and kept unchanged through it.
 * Real Postgres; the LiveKit server is a recording fake. Only the harness
 * (livekit.test-harness.ts) knows how the service is constructed.
 */

let pg: PostgresProvider;
let owner: string;
let member: string;
let outsider: string;
let movie: string;

beforeAll(() => {
    pg = connectTestPostgres();
});
afterAll(async () => {
    await pg.onModuleDestroy();
});
beforeEach(async () => {
    silenceNestLogger();
    await resetDatabase(pg);
    owner = await insertUser(pg, "owner");
    member = await insertUser(pg, "member");
    outsider = await insertUser(pg, "outsider");
    movie = await insertMovie(pg);
});
afterEach(() => {
    jest.restoreAllMocks();
});

const MISSING = "00000000-0000-4000-8000-000000000000";

function build() {
    return buildLiveKit({
        pg,
        rooms: new RoomAccessQuery(pg),
        events: new MediaSessionEvents(),
    });
}

async function insertRoom(lifecycle = "ACTIVE", code = "ROOM01") {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.rooms (room_code, "password", owner_id, movie_id, max_participants,
                                   lifecycle_status, is_active)
         VALUES ($1, 'x', $2, $3, 4, $4::public.room_lifecycle_status, $4 = 'ACTIVE') RETURNING id`,
        [code, owner, movie, lifecycle],
    );
    return rows[0].id;
}

async function deactivateRoom(roomId: string) {
    await pg.query(
        `UPDATE public.rooms SET lifecycle_status = 'TERMINATING', is_active = false WHERE id = $1`,
        [roomId],
    );
}

async function addMember(roomId: string, userId: string, active = true) {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.room_participants (room_id, user_id, is_active)
         VALUES ($1, $2, $3) RETURNING id`,
        [roomId, userId, active],
    );
    return rows[0].id;
}

async function insertSession(roomId: string, status: string, ageSeconds = 0) {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.media_sessions (room_id, status, created_at)
         VALUES ($1, $2::public.media_session_status, NOW() - make_interval(secs => $3))
         RETURNING id`,
        [roomId, status, ageSeconds],
    );
    return rows[0].id;
}

async function sessions(roomId: string) {
    const { rows } = await pg.query<{
        id: string;
        status: string;
        started_at: Date | null;
        ended_at: Date | null;
    }>(
        `SELECT id, status, started_at, ended_at FROM public.media_sessions
         WHERE room_id = $1 ORDER BY created_at`,
        [roomId],
    );
    return rows;
}

async function statusOf(id: string) {
    const { rows } = await pg.query<{ status: string }>(
        `SELECT status FROM public.media_sessions WHERE id = $1`,
        [id],
    );
    return rows[0]?.status;
}

/** Outbox events for a session: delay in whole seconds from creation. */
async function outbox(mediaSessionId: string) {
    const { rows } = await pg.query<{ event_type: string; delay: number }>(
        `SELECT event_type,
                ROUND(EXTRACT(EPOCH FROM next_attempt_at - created_at))::int AS delay
         FROM public.room_lifecycle_outbox WHERE aggregate_id = $1 ORDER BY created_at`,
        [mediaSessionId],
    );
    return rows;
}

async function expectHttp(
    promise: Promise<unknown>,
    status: number,
    message: string,
) {
    const error: unknown = await promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).message).toBe(message);
}

const notFound = (): Error =>
    Object.assign(new Error("not here"), {
        status: 404,
    });

/** Every shape of provider error the service treats as "already gone". */
const NOT_FOUND_SHAPES: [string, () => unknown][] = [
    [
        "statusCode 404",
        () => Object.assign(new Error("x"), { statusCode: 404 }),
    ],
    ["status 404", () => Object.assign(new Error("x"), { status: 404 })],
    ["code 404", () => Object.assign(new Error("x"), { code: 404 })],
    [
        "code NOT_FOUND",
        () => Object.assign(new Error("x"), { code: "NOT_FOUND" }),
    ],
    [
        "code not_found",
        () => Object.assign(new Error("x"), { code: "not_found" }),
    ],
    ["room not found message", () => new Error("Room ABC not found")],
    [
        "participant does not exist message",
        () => new Error("participant p1 does not exist"),
    ],
];

function providerCalls(provider: FakeProvider) {
    return provider.calls.map((c) => c.join(" "));
}

// ------------------------------------------------------------ getOrCreate --

describe("getOrCreateMediaSession", () => {
    it("creates, provisions and activates a session for an ACTIVE room", async () => {
        const roomId = await insertRoom();
        const { service, provider } = build();

        const session = await service.getOrCreateMediaSession(roomId);

        expect(session).toMatchObject({ roomId, status: "ACTIVE" });
        expect(session.startedAt).toBeInstanceOf(Date);
        expect(providerCalls(provider)).toEqual([`createRoom ${session.id} 4`]);
        const [row] = await sessions(roomId);
        expect(row).toMatchObject({ id: session.id, status: "ACTIVE" });
        // The startup reconcile is delayed past the 30 s startup window.
        expect(await outbox(session.id)).toEqual([
            { event_type: "LIVEKIT_SESSION_RECONCILE", delay: 35 },
        ]);
    });

    it("returns the existing ACTIVE session without touching the provider", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();

        const session = await service.getOrCreateMediaSession(roomId);

        expect(session.id).toBe(id);
        expect(provider.calls).toEqual([]);
    });

    it("an ACTIVE session of a room that stopped being ACTIVE is refused", async () => {
        const roomId = await insertRoom();
        await insertSession(roomId, "ACTIVE");
        await deactivateRoom(roomId);

        await expectHttp(
            build().service.getOrCreateMediaSession(roomId),
            409,
            "The watch room is no longer accepting media connections.",
        );
    });

    it("an unknown room is 404", async () => {
        await expectHttp(
            build().service.getOrCreateMediaSession(MISSING),
            404,
            "The requested watch room does not exist.",
        );
    });

    it("an inactive room without a session is 409 and creates nothing", async () => {
        const roomId = await insertRoom("TERMINATING");
        const { service, provider } = build();

        await expectHttp(
            service.getOrCreateMediaSession(roomId),
            409,
            "Cannot create a media session for an inactive room.",
        );
        expect(await sessions(roomId)).toEqual([]);
        expect(provider.calls).toEqual([]);
    });

    it("a fresh STARTING session is still starting: 409, untouched", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "STARTING", 5);
        const { service, provider } = build();

        await expectHttp(
            service.getOrCreateMediaSession(roomId),
            409,
            "The room's LiveKit media session is still starting. Retry the connection shortly.",
        );
        expect(await statusOf(id)).toBe("STARTING");
        expect(provider.calls).toEqual([]);
    });

    it("a stale STARTING session is ended and replaced", async () => {
        const roomId = await insertRoom();
        const stale = await insertSession(roomId, "STARTING", 60);
        const { service, provider } = build();

        const session = await service.getOrCreateMediaSession(roomId);

        expect(session.id).not.toBe(stale);
        expect(session.status).toBe("ACTIVE");
        expect(await statusOf(stale)).toBe("ENDED");
        expect(providerCalls(provider)).toEqual([
            `deleteRoom ${stale}`,
            `createRoom ${session.id} 4`,
        ]);
        expect(await outbox(stale)).toEqual([
            { event_type: "LIVEKIT_SESSION_RECONCILE", delay: 0 },
        ]);
    });

    it("an ENDING session is finished and replaced", async () => {
        const roomId = await insertRoom();
        const ending = await insertSession(roomId, "ENDING");
        const { service, provider } = build();

        const session = await service.getOrCreateMediaSession(roomId);

        expect(await statusOf(ending)).toBe("ENDED");
        expect(session.status).toBe("ACTIVE");
        expect(providerCalls(provider)).toEqual([
            `deleteRoom ${ending}`,
            `createRoom ${session.id} 4`,
        ]);
        // Already ENDING: no new ENDING transition, so no new outbox event.
        expect(await outbox(ending)).toEqual([]);
    });

    it("a CREATED session is started rather than replaced", async () => {
        const roomId = await insertRoom();
        const created = await insertSession(roomId, "CREATED");
        const { service, provider } = build();

        const session = await service.getOrCreateMediaSession(roomId);

        expect(session).toMatchObject({ id: created, status: "ACTIVE" });
        expect(providerCalls(provider)).toEqual([`createRoom ${created} 4`]);
    });

    it("a provider failure during startup ends the session and rethrows the same error", async () => {
        const roomId = await insertRoom();
        const { service, provider } = build();
        const boom = new Error("livekit down");
        provider.fail("createRoom", boom);

        await expect(service.getOrCreateMediaSession(roomId)).rejects.toBe(
            boom,
        );

        const [row] = await sessions(roomId);
        expect(row.status).toBe("ENDED");
        // Once by the ENDING cleanup, once more after creation settled.
        expect(providerCalls(provider)).toEqual([
            `createRoom ${row.id} 4`,
            `deleteRoom ${row.id}`,
            `deleteRoom ${row.id}`,
        ]);
    });

    it("a concurrent insert (unique index) is resolved by reading the winner", async () => {
        const roomId = await insertRoom();
        const winner = await insertSession(roomId, "ACTIVE");
        const h = build();
        // Hide the winner from the pre-insert check so the INSERT hits
        // idx_active_media_session_room, as two racing requests would.
        h.hideOpenSessionFromCreateCheck();

        const session = await h.service.getOrCreateMediaSession(roomId);

        expect(session.id).toBe(winner);
        expect(h.provider.calls).toEqual([]);
    });
});

describe("getOrCreateMediaSessionForMember", () => {
    it("refuses a caller without an active membership (403)", async () => {
        const roomId = await insertRoom();
        await addMember(roomId, member, false);

        await expectHttp(
            build().service.getOrCreateMediaSessionForMember(roomId, member),
            403,
            "Only active members of an active room can start its media session.",
        );
        expect(await sessions(roomId)).toEqual([]);
    });

    it("an active member gets the room's session", async () => {
        const roomId = await insertRoom();
        await addMember(roomId, member);

        const session = await build().service.getOrCreateMediaSessionForMember(
            roomId,
            member,
        );
        expect(session).toMatchObject({ roomId, status: "ACTIVE" });
    });
});

describe("startMediaSession", () => {
    it("only a CREATED session can start", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");

        await expectHttp(
            build().service.startMediaSession(id),
            409,
            "MediaSession cannot start from status ACTIVE.",
        );
    });

    it("a CREATED session of an inactive room is 404", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "CREATED");
        await deactivateRoom(roomId);

        await expectHttp(
            build().service.startMediaSession(id),
            404,
            "The MediaSession watch room does not exist or is inactive.",
        );
        expect(await statusOf(id)).toBe("CREATED");
    });

    it("an unknown session is 404", async () => {
        await expectHttp(
            build().service.startMediaSession(MISSING),
            404,
            "The requested media session does not exist.",
        );
    });
});

// -------------------------------------------------------------------- end --

describe("endMediaSessionForRoom / endMediaSessionById", () => {
    it("a room without a session is a no-op", async () => {
        const roomId = await insertRoom();
        const { service, provider } = build();

        await service.endMediaSessionForRoom(roomId);

        expect(provider.calls).toEqual([]);
    });

    it("ACTIVE: ENDING with an immediate reconcile event, provider room deleted, then ENDED", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();

        await service.endMediaSessionForRoom(roomId);

        const [row] = await sessions(roomId);
        expect(row.status).toBe("ENDED");
        expect(row.ended_at).toBeInstanceOf(Date);
        expect(providerCalls(provider)).toEqual([`deleteRoom ${id}`]);
        expect(await outbox(id)).toEqual([
            { event_type: "LIVEKIT_SESSION_RECONCILE", delay: 0 },
        ]);
    });

    it("a provider 404 on delete is treated as already gone", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();
        provider.fail("deleteRoom", notFound());

        await service.endMediaSessionById(id);

        expect(await statusOf(id)).toBe("ENDED");
    });

    it.each(NOT_FOUND_SHAPES)(
        "provider error with %s counts as already deleted",
        async (_shape, makeError) => {
            const roomId = await insertRoom();
            const id = await insertSession(roomId, "ACTIVE");
            const { service, provider } = build();
            provider.fail("deleteRoom", makeError());

            await service.endMediaSessionById(id);

            expect(await statusOf(id)).toBe("ENDED");
        },
    );

    it.each([
        ["status 500", () => Object.assign(new Error("boom"), { status: 500 })],
        ["code 403", () => Object.assign(new Error("x"), { code: 403 })],
        ["unrelated message", () => new Error("token not found in cache")],
        ["non-object", () => "boom"],
    ] as [string, () => unknown][])(
        "provider error with %s is not a not-found",
        async (_shape, makeError) => {
            const roomId = await insertRoom();
            const id = await insertSession(roomId, "ACTIVE");
            const { service, provider } = build();
            const error = makeError();
            provider.fail("deleteRoom", error);

            await expect(service.endMediaSessionById(id)).rejects.toBe(error);
            expect(await statusOf(id)).toBe("ENDING");
        },
    );

    it("any other provider error leaves the session ENDING for retry", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();
        const boom = new Error("livekit 500");
        provider.fail("deleteRoom", boom);

        await expect(service.endMediaSessionById(id)).rejects.toBe(boom);

        expect(await statusOf(id)).toBe("ENDING");
    });

    it("CREATED never reached the provider: ended without a delete", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "CREATED");
        const { service, provider } = build();

        await service.endMediaSessionById(id);

        expect(await statusOf(id)).toBe("ENDED");
        expect(provider.calls).toEqual([]);
    });

    it("ENDED is a no-op", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ENDED");
        const { service, provider } = build();

        await service.endMediaSessionById(id);

        expect(provider.calls).toEqual([]);
        expect(await outbox(id)).toEqual([]);
    });

    it("an unknown session is 404", async () => {
        await expectHttp(
            build().service.endMediaSessionById(MISSING),
            404,
            "The requested media session does not exist.",
        );
    });
});

// -------------------------------------------------------------- reconcile --

describe("reconcileMediaSession", () => {
    const longAgo = () => new Date(Date.now() - 60_000);

    it("an unknown session is a no-op", async () => {
        const { service, provider } = build();
        await service.reconcileMediaSession(MISSING, longAgo());
        expect(provider.calls).toEqual([]);
    });

    it("ACTIVE is left alone", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();

        await service.reconcileMediaSession(id, longAgo());

        expect(await statusOf(id)).toBe("ACTIVE");
        expect(provider.calls).toEqual([]);
    });

    it("CREATED stays while its room is ACTIVE, and is ended once it is not", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "CREATED");
        const { service, provider } = build();

        await service.reconcileMediaSession(id, longAgo());
        expect(await statusOf(id)).toBe("CREATED");

        await deactivateRoom(roomId);
        await service.reconcileMediaSession(id, longAgo());
        expect(await statusOf(id)).toBe("ENDED");
        expect(provider.calls).toEqual([]);
    });

    it("ENDED deletes the provider room again, ignoring 404", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ENDED");
        const { service, provider } = build();
        provider.fail("deleteRoom", notFound());

        await service.reconcileMediaSession(id, longAgo());

        expect(providerCalls(provider)).toEqual([`deleteRoom ${id}`]);
    });

    it("ENDING is finished", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ENDING");
        const { service } = build();

        await service.reconcileMediaSession(id, longAgo());

        expect(await statusOf(id)).toBe("ENDED");
    });

    it("STARTING inside the recovery window is 409; after it, it is ended", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "STARTING");
        const { service, provider } = build();

        await expectHttp(
            service.reconcileMediaSession(id, new Date()),
            409,
            "LiveKit startup is still within its recovery window.",
        );
        expect(await statusOf(id)).toBe("STARTING");

        await service.reconcileMediaSession(id, longAgo().toISOString());
        expect(await statusOf(id)).toBe("ENDED");
        expect(providerCalls(provider)).toEqual([`deleteRoom ${id}`]);
    });
});

describe("reconcileRoomParticipants", () => {
    it("does nothing without an ACTIVE session", async () => {
        const roomId = await insertRoom();
        await insertSession(roomId, "CREATED");
        const { service, provider } = build();
        const load = jest.fn();

        await service.reconcileRoomParticipants(MISSING, load);
        await service.reconcileRoomParticipants(roomId, load);

        expect(provider.calls).toEqual([]);
        expect(load).not.toHaveBeenCalled();
    });

    it("removes provider participants without an allowed identity, loading identities after listing", async () => {
        const roomId = await insertRoom();
        const id = await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();
        provider.participants = ["keep", "gone-1", "gone-2"];
        provider.fail("removeParticipant", notFound());
        const load = jest.fn(() => {
            provider.calls.push(["loadAllowedIdentities"]);
            return Promise.resolve(new Set(["keep"]) as ReadonlySet<string>);
        });
        const logged = jest.spyOn(Logger.prototype, "log");

        await service.reconcileRoomParticipants(roomId, load);

        expect(providerCalls(provider)).toEqual([
            `listParticipants ${id}`,
            "loadAllowedIdentities",
            `removeParticipant ${id} gone-1`,
            `removeParticipant ${id} gone-2`,
        ]);
        // gone-1 was already gone (404): only gone-2's removal is logged.
        const removals = logged.mock.calls.filter(
            ([entry]) =>
                (entry as { participantIdentity?: string }).participantIdentity,
        );
        expect(removals).toEqual([
            [
                {
                    message:
                        "Removed LiveKit participant without an active room membership",
                    mediaSessionId: id,
                    roomId,
                    participantIdentity: "gone-2",
                },
            ],
        ]);
    });

    it("an empty or missing provider room needs no membership read", async () => {
        const roomId = await insertRoom();
        await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();
        const load = jest.fn();

        await service.reconcileRoomParticipants(roomId, load);
        provider.fail("listParticipants", notFound());
        await service.reconcileRoomParticipants(roomId, load);

        expect(load).not.toHaveBeenCalled();
    });

    it("other provider errors propagate unchanged", async () => {
        const roomId = await insertRoom();
        await insertSession(roomId, "ACTIVE");
        const { service, provider } = build();
        provider.participants = ["gone"];
        const boom = new Error("livekit 500");
        provider.fail("removeParticipant", boom);

        await expect(
            service.reconcileRoomParticipants(roomId, () =>
                Promise.resolve(new Set<string>()),
            ),
        ).rejects.toBe(boom);
    });
});

// ---------------------------------------------------------------- connect --

describe("createMediaSessionConnection", () => {
    it("issues a 10-minute publish/subscribe token for the member's identity", async () => {
        const roomId = await insertRoom();
        const membershipId = await addMember(roomId, member);
        const id = await insertSession(roomId, "ACTIVE");
        const { service, tokens } = build();

        const connection = await service.createMediaSessionConnection(
            id,
            member,
        );

        expect(connection).toEqual({
            mediaSessionId: id,
            participantId: membershipId,
            serverUrl: "wss://livekit.test",
            participantToken: `token-for-${membershipId}`,
        });
        expect(tokens.issued).toEqual([
            {
                roomName: id,
                participantIdentity: membershipId,
                ttl: "10m",
                canPublish: true,
                canSubscribe: true,
                canPublishData: true,
            },
        ]);
    });

    it("a session that is not ACTIVE is 409", async () => {
        const roomId = await insertRoom();
        await addMember(roomId, member);
        const id = await insertSession(roomId, "CREATED");

        await expectHttp(
            build().service.createMediaSessionConnection(id, member),
            409,
            "MediaSession cannot be connected from status CREATED.",
        );
    });

    it("a caller who is not an active member is 404", async () => {
        const roomId = await insertRoom();
        await addMember(roomId, member);
        const id = await insertSession(roomId, "ACTIVE");
        const { service, tokens } = build();

        await expectHttp(
            service.createMediaSessionConnection(id, outsider),
            404,
            "The authenticated user is not a participant of the MediaSession room.",
        );
        expect(tokens.issued).toEqual([]);
    });

    it("an unknown session is 404", async () => {
        await expectHttp(
            build().service.createMediaSessionConnection(MISSING, member),
            404,
            "The requested media session does not exist.",
        );
    });
});
