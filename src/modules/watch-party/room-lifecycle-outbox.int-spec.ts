import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { RoomLifecycleOutboxService } from "./infrastructure/outbox/room-lifecycle-outbox.service.js";
import { RoomLifecycleOutboxRepository } from "./infrastructure/persistence/room-lifecycle-outbox.repository.js";
import type { MediaSessionPort } from "./application/ports/collaborators.port.js";
import {
    connectTestPostgres,
    insertMovie,
    insertUser,
    resetDatabase,
    silenceNestLogger,
} from "../../../test/integration/fixtures.js";

/*
 * Characterization tests (refactor plan, phase 3 prerequisite) for the room
 * lifecycle outbox on the disposable Postgres: per-state reconciliation,
 * claim/complete/retry/dead-letter, and the sweeper. Redis and LiveKit are
 * mocked at their ports; every SQL statement is real.
 *
 * `drive()` is the one place these tests reach the outbox's internal batch
 * and sweep loops; repoint it when the loops move to the outbox worker.
 */

let pg: PostgresProvider;
let repo: RoomLifecycleOutboxRepository;
let owner: string;
let member: string;
let movie: string;

beforeAll(() => {
    silenceNestLogger();
    pg = connectTestPostgres();
    repo = new RoomLifecycleOutboxRepository(pg);
});

afterAll(async () => {
    await pg.onModuleDestroy();
});

beforeEach(async () => {
    await resetDatabase(pg);
    owner = await insertUser(pg, "owner");
    member = await insertUser(pg, "member");
    movie = await insertMovie(pg);
});

function setup() {
    const projection = {
        reconcileRoomState: jest.fn().mockResolvedValue(true),
        replaceStaleRoomState: jest.fn().mockResolvedValue(true),
        getRoomState: jest.fn().mockResolvedValue({}),
    };
    const allowedIdentities: Array<ReadonlySet<string>> = [];
    const media = {
        reconcileMediaSession: jest.fn().mockResolvedValue(undefined),
        endMediaSessionForRoom: jest.fn().mockResolvedValue(undefined),
        reconcileRoomParticipants: jest.fn(
            async (
                _roomId: string,
                load: () => Promise<ReadonlySet<string>>,
            ) => {
                allowedIdentities.push(await load());
            },
        ),
    };
    const outbox = new RoomLifecycleOutboxService(
        repo,
        projection,
        media as unknown as MediaSessionPort,
    );
    return { outbox, projection, media, allowedIdentities };
}

function drive(outbox: RoomLifecycleOutboxService) {
    const internals = outbox as unknown as {
        processBatch(): Promise<void>;
        sweep(): Promise<void>;
    };
    return {
        processBatch: () => internals.processBatch(),
        sweep: () => internals.sweep(),
    };
}

type Lifecycle = "PROVISIONING" | "ACTIVE" | "TERMINATING" | "TERMINATED";

async function insertRoom(
    lifecycle: Lifecycle,
    p: { code?: string; ageMinutes?: number; ownerId?: string } = {},
) {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.rooms (room_code, "password", owner_id, movie_id, max_participants,
                                   lifecycle_status, is_active, state_version, created_at)
         VALUES ($1, 'x', $2, $3, 5, $4::public.room_lifecycle_status, $4 = 'ACTIVE', 7,
                 NOW() - ($5 * INTERVAL '1 minute'))
         RETURNING id`,
        [
            p.code ?? "ROOM01",
            p.ownerId ?? owner,
            movie,
            lifecycle,
            p.ageMinutes ?? 0,
        ],
    );
    return rows[0].id;
}

async function addMember(roomId: string, userId: string, active = true) {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.room_participants (room_id, user_id, is_active, left_at)
         VALUES ($1, $2, $3, CASE WHEN $3 THEN NULL ELSE NOW() END) RETURNING id`,
        [roomId, userId, active],
    );
    return rows[0].id;
}

async function room(id: string) {
    const { rows } = await pg.query<{
        lifecycle_status: string;
        is_active: boolean;
        state_version: string;
    }>(
        `SELECT lifecycle_status, is_active, state_version FROM public.rooms WHERE id = $1`,
        [id],
    );
    return rows[0];
}

async function events(aggregateId?: string) {
    const { rows } = await pg.query<{
        event_type: string;
        status: string;
        attempts: number;
        last_error: string | null;
        due_in_future: boolean;
    }>(
        `SELECT event_type, status, attempts, last_error, next_attempt_at > NOW() AS due_in_future
         FROM public.room_lifecycle_outbox
         WHERE $1::uuid IS NULL OR aggregate_id = $1
         ORDER BY created_at, event_id`,
        [aggregateId ?? null],
    );
    return rows;
}

describe("RoomLifecycleOutboxService on real Postgres", () => {
    describe("reconcile one room (provisionRoomNow)", () => {
        it("PROVISIONING: projects PROVISIONING, activates the room and enqueues the follow-up", async () => {
            const { outbox, projection } = setup();
            const roomId = await insertRoom("PROVISIONING");
            await addMember(roomId, owner);

            await outbox.provisionRoomNow(roomId);

            expect(projection.reconcileRoomState).toHaveBeenCalledWith(
                "ROOM01",
                {
                    roomId,
                    lifecycleVersion: "7",
                    lifecycleStatus: "PROVISIONING",
                    roomCode: "ROOM01",
                    ownerId: owner,
                    movieId: movie,
                    maxParticipants: 5,
                    participantCount: 1,
                    status: "PAUSED",
                    playhead: 0,
                    lastUpdated: expect.any(Number) as number,
                },
            );
            expect(await room(roomId)).toEqual({
                lifecycle_status: "ACTIVE",
                is_active: true,
                state_version: "8",
            });
            expect(await events(roomId)).toEqual([
                expect.objectContaining({
                    event_type: "ROOM_RECONCILE",
                    status: "PENDING",
                }),
            ]);
        });

        it("PROVISIONING: takes over a stale Redis key left by a TERMINATED room", async () => {
            const { outbox, projection } = setup();
            const holder = await insertRoom("TERMINATED", { code: "ROOM01" });
            const roomId = await insertRoom("PROVISIONING", { code: "ROOM01" });
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({ roomId: holder });

            await outbox.provisionRoomNow(roomId);

            expect(projection.replaceStaleRoomState).toHaveBeenCalledWith(
                "ROOM01",
                holder,
                expect.objectContaining({
                    roomId,
                    lifecycleStatus: "PROVISIONING",
                }),
            );
            expect((await room(roomId)).lifecycle_status).toBe("ACTIVE");
        });

        it("PROVISIONING: takes over a key whose holder now has another code", async () => {
            const { outbox, projection } = setup();
            const holder = await insertRoom("ACTIVE", {
                code: "OTHER1",
                ownerId: member,
            });
            const roomId = await insertRoom("PROVISIONING", { code: "ROOM01" });
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({ roomId: holder });

            await outbox.provisionRoomNow(roomId);

            expect(projection.replaceStaleRoomState).toHaveBeenCalledWith(
                "ROOM01",
                holder,
                expect.anything(),
            );
            expect((await room(roomId)).lifecycle_status).toBe("ACTIVE");
        });

        it("PROVISIONING: a rejected write by the same generation counts as projected", async () => {
            // A later reconciliation already wrote a newer version for this room.
            const { outbox, projection } = setup();
            const roomId = await insertRoom("PROVISIONING");
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({ roomId });

            await outbox.provisionRoomNow(roomId);

            expect(projection.replaceStaleRoomState).not.toHaveBeenCalled();
            expect((await room(roomId)).lifecycle_status).toBe("ACTIVE");
        });

        it("PROVISIONING: a live generation still owning the code fails and stays PROVISIONING", async () => {
            // The partial unique index stops two reserving rooms sharing a code,
            // so this guard only fires in a race; the holder lookup is stubbed
            // to reach it.
            const { outbox, projection } = setup();
            const roomId = await insertRoom("PROVISIONING");
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({
                roomId: "holder-room",
            });
            jest.spyOn(repo, "findRoomCodeHolder").mockResolvedValueOnce({
                room_code: "ROOM01",
                lifecycle_status: "TERMINATING",
            } as never);

            await expect(outbox.provisionRoomNow(roomId)).rejects.toThrow(
                "Redis room-code key is owned by a different nonterminated room generation.",
            );
            expect(projection.replaceStaleRoomState).not.toHaveBeenCalled();
            expect((await room(roomId)).lifecycle_status).toBe("PROVISIONING");
        });

        it("PROVISIONING: a key that changed during takeover fails so the event retries", async () => {
            const { outbox, projection } = setup();
            const holder = await insertRoom("TERMINATED", { code: "ROOM01" });
            const roomId = await insertRoom("PROVISIONING", { code: "ROOM01" });
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({ roomId: holder });
            projection.replaceStaleRoomState.mockResolvedValue(false);

            await expect(outbox.provisionRoomNow(roomId)).rejects.toThrow(
                "Redis room-code key is owned by a different nonterminated room generation.",
            );
            expect((await room(roomId)).lifecycle_status).toBe("PROVISIONING");
        });

        it("ACTIVE: projects ACTIVE and reconciles media participants to active memberships", async () => {
            const { outbox, projection, media, allowedIdentities } = setup();
            const roomId = await insertRoom("ACTIVE");
            const ownerMembership = await addMember(roomId, owner);
            await addMember(roomId, member, false);

            await outbox.provisionRoomNow(roomId);

            expect(projection.reconcileRoomState).toHaveBeenCalledWith(
                "ROOM01",
                {
                    roomId,
                    lifecycleVersion: "7",
                    lifecycleStatus: "ACTIVE",
                    roomCode: "ROOM01",
                    ownerId: owner,
                    movieId: movie,
                    maxParticipants: 5,
                    participantCount: 1,
                },
            );
            expect(media.reconcileRoomParticipants).toHaveBeenCalledWith(
                roomId,
                expect.any(Function),
            );
            expect(allowedIdentities).toEqual([new Set([ownerMembership])]);
            expect((await room(roomId)).state_version).toBe("7");
        });

        it("ACTIVE: a live generation owning the code fails before touching media", async () => {
            const { outbox, projection, media } = setup();
            const roomId = await insertRoom("ACTIVE");
            projection.reconcileRoomState.mockResolvedValue(false);
            projection.getRoomState.mockResolvedValue({
                roomId: "holder-room",
            });
            jest.spyOn(repo, "findRoomCodeHolder").mockResolvedValueOnce({
                room_code: "ROOM01",
                lifecycle_status: "ACTIVE",
            } as never);

            await expect(outbox.provisionRoomNow(roomId)).rejects.toThrow(
                "Redis room-code key is owned by a different nonterminated room generation.",
            );
            expect(media.reconcileRoomParticipants).not.toHaveBeenCalled();
        });

        it("TERMINATING: ends media, writes the tombstone and marks the room TERMINATED", async () => {
            const { outbox, projection, media } = setup();
            const roomId = await insertRoom("TERMINATING");

            await outbox.provisionRoomNow(roomId);

            expect(media.endMediaSessionForRoom).toHaveBeenCalledWith(roomId);
            expect(projection.reconcileRoomState).toHaveBeenCalledWith(
                "ROOM01",
                {
                    roomId,
                    lifecycleVersion: "7",
                    lifecycleStatus: "TERMINATED",
                },
            );
            expect(await room(roomId)).toMatchObject({
                lifecycle_status: "TERMINATED",
                state_version: "8",
            });
            expect(await events(roomId)).toHaveLength(1);
        });

        it("TERMINATING: a media failure leaves the room TERMINATING for a retry", async () => {
            const { outbox, media } = setup();
            const roomId = await insertRoom("TERMINATING");
            media.endMediaSessionForRoom.mockRejectedValue(
                new Error("livekit down"),
            );

            await expect(outbox.provisionRoomNow(roomId)).rejects.toThrow(
                "livekit down",
            );
            expect((await room(roomId)).lifecycle_status).toBe("TERMINATING");
        });

        it("TERMINATED: re-applies the tombstone only", async () => {
            const { outbox, projection, media } = setup();
            const roomId = await insertRoom("TERMINATED");

            await outbox.provisionRoomNow(roomId);

            expect(projection.reconcileRoomState).toHaveBeenCalledTimes(1);
            expect(projection.reconcileRoomState).toHaveBeenCalledWith(
                "ROOM01",
                expect.objectContaining({
                    roomId,
                    lifecycleStatus: "TERMINATED",
                }),
            );
            expect(media.reconcileRoomParticipants).not.toHaveBeenCalled();
            expect(media.endMediaSessionForRoom).not.toHaveBeenCalled();
        });

        it("an unknown room is a no-op", async () => {
            const { outbox, projection } = setup();
            await outbox.provisionRoomNow(
                "00000000-0000-4000-8000-000000000000",
            );
            expect(projection.reconcileRoomState).not.toHaveBeenCalled();
        });
    });

    describe("event processing", () => {
        it("enqueue → claim → complete", async () => {
            const { outbox } = setup();
            const roomId = await insertRoom("TERMINATED");
            await outbox.requestRoomReconciliation(roomId);

            await drive(outbox).processBatch();

            expect(await events(roomId)).toEqual([
                expect.objectContaining({
                    status: "COMPLETED",
                    attempts: 1,
                    last_error: null,
                }),
            ]);
        });

        it("a failure is retried later with the error recorded", async () => {
            const { outbox, media } = setup();
            const roomId = await insertRoom("TERMINATING");
            media.endMediaSessionForRoom.mockRejectedValue(
                new Error("livekit down"),
            );
            await outbox.requestRoomReconciliation(roomId);

            await drive(outbox).processBatch();

            expect(await events(roomId)).toEqual([
                expect.objectContaining({
                    status: "PENDING",
                    attempts: 1,
                    last_error: "livekit down",
                    due_in_future: true,
                }),
            ]);
            // Not due yet: a second batch does not pick it up again.
            await drive(outbox).processBatch();
            expect((await events(roomId))[0].attempts).toBe(1);
        });

        it("parks an event as DEAD once it has been attempted 20 times", async () => {
            const { outbox, media } = setup();
            const roomId = await insertRoom("TERMINATING");
            media.endMediaSessionForRoom.mockRejectedValue(
                new Error("still down"),
            );
            await pg.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id, attempts)
                 VALUES ('ROOM_RECONCILE', $1, 19)`,
                [roomId],
            );

            await drive(outbox).processBatch();

            expect(await events(roomId)).toEqual([
                expect.objectContaining({
                    status: "DEAD",
                    attempts: 20,
                    last_error: "still down",
                }),
            ]);
        });

        it("routes LIVEKIT_SESSION_RECONCILE to the media port", async () => {
            const { outbox, media } = setup();
            const sessionId = "11111111-1111-4111-8111-111111111111";
            await pg.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id)
                 VALUES ('LIVEKIT_SESSION_RECONCILE', $1)`,
                [sessionId],
            );

            await drive(outbox).processBatch();

            expect(media.reconcileMediaSession).toHaveBeenCalledWith(
                sessionId,
                expect.any(Date),
            );
            expect(await events(sessionId)).toEqual([
                expect.objectContaining({ status: "COMPLETED" }),
            ]);
        });

        it("drains at most 10 events per batch, oldest first", async () => {
            const { outbox } = setup();
            const roomId = await insertRoom("TERMINATED");
            for (let i = 0; i < 12; i += 1)
                await outbox.requestRoomReconciliation(roomId);

            await drive(outbox).processBatch();

            const statuses = (await events(roomId)).map((e) => e.status);
            expect(statuses.filter((s) => s === "COMPLETED")).toHaveLength(10);
            expect(statuses.slice(10)).toEqual(["PENDING", "PENDING"]);
        });
    });

    describe("sweeper", () => {
        it("terminates PROVISIONING rooms older than 10 minutes and ends their memberships", async () => {
            const { outbox } = setup();
            const stale = await insertRoom("PROVISIONING", { ageMinutes: 11 });
            const fresh = await insertRoom("PROVISIONING", {
                code: "FRESH1",
                ageMinutes: 5,
                ownerId: member,
            });
            await addMember(stale, owner);

            await drive(outbox).sweep();

            expect(await room(stale)).toMatchObject({
                lifecycle_status: "TERMINATING",
                state_version: "8",
            });
            const { rows } = await pg.query(
                `SELECT 1 FROM public.room_participants WHERE room_id = $1 AND is_active`,
                [stale],
            );
            expect(rows).toHaveLength(0);
            expect((await room(fresh)).lifecycle_status).toBe("PROVISIONING");
            // Each transitional room has exactly one live event afterwards.
            expect(await events(stale)).toEqual([
                expect.objectContaining({ status: "PENDING" }),
            ]);
            expect(await events(fresh)).toEqual([
                expect.objectContaining({ status: "PENDING" }),
            ]);
        });

        it("re-enqueues a transitional room whose event went DEAD, but not twice", async () => {
            const { outbox } = setup();
            const roomId = await insertRoom("TERMINATING");
            await pg.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id, status, attempts)
                 VALUES ('ROOM_RECONCILE', $1, 'DEAD', 20)`,
                [roomId],
            );

            await drive(outbox).sweep();
            await drive(outbox).sweep();

            expect((await events(roomId)).map((e) => e.status)).toEqual([
                "DEAD",
                "PENDING",
            ]);
        });

        it("leaves ACTIVE and TERMINATED rooms alone", async () => {
            const { outbox } = setup();
            await insertRoom("ACTIVE");
            await insertRoom("TERMINATED", { code: "DONE01" });

            await drive(outbox).sweep();

            expect(await events()).toEqual([]);
        });

        it("re-enqueues stuck media sessions older than 2 minutes", async () => {
            const { outbox } = setup();
            const roomId = await insertRoom("TERMINATED");
            const { rows } = await pg.query<{ id: string }>(
                `INSERT INTO public.media_sessions (room_id, status, created_at)
                 VALUES ($1, 'ENDING', NOW() - INTERVAL '3 minutes'),
                        ($1, 'ENDED', NOW() - INTERVAL '3 minutes')
                 RETURNING id`,
                [roomId],
            );

            await drive(outbox).sweep();

            expect(await events(rows[0].id)).toEqual([
                expect.objectContaining({
                    event_type: "LIVEKIT_SESSION_RECONCILE",
                    status: "PENDING",
                }),
            ]);
            expect(await events(rows[1].id)).toEqual([]);
        });

        it("prunes COMPLETED events older than 7 days", async () => {
            const { outbox } = setup();
            const roomId = await insertRoom("TERMINATED");
            await pg.query(
                `INSERT INTO public.room_lifecycle_outbox (event_type, aggregate_id, status, completed_at)
                 VALUES ('ROOM_RECONCILE', $1, 'COMPLETED', NOW() - INTERVAL '8 days'),
                        ('ROOM_RECONCILE', $1, 'COMPLETED', NOW() - INTERVAL '6 days')`,
                [roomId],
            );

            await drive(outbox).sweep();

            expect(await events(roomId)).toHaveLength(1);
        });
    });
});
