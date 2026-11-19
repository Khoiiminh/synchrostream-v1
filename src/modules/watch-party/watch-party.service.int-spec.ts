import { HttpException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { AttemptLimiter } from "@/shared/infrastructure/cache/attempt-limiter.js";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyRepository } from "./infrastructure/persistence/watch-party.repository.js";
import { RoomLifecycleOutboxRepository } from "./infrastructure/persistence/room-lifecycle-outbox.repository.js";
import { BcryptPasswordHasher } from "./infrastructure/security/bcrypt-password-hasher.js";
import type { RoomLifecycleOutboxService } from "./infrastructure/outbox/room-lifecycle-outbox.service.js";
import {
    connectTestPostgres,
    insertMovie,
    insertUser,
    resetDatabase,
    silenceNestLogger,
} from "../../../test/integration/fixtures.js";

/*
 * Integration tests (refactor plan, phase 0) against a disposable Postgres 18
 * built from the real migrations: `npm run test:int:db`, then `npm run test:int`.
 *
 * These pin what the mocked contract tests cannot: the SQL itself, the row
 * locks, the owner advisory lock and the partial unique indexes
 * (idx_active_room_code, idx_one_active_room_per_user) under real
 * concurrency. Only LiveKit/Redis side effects are left out: inline
 * provisioning is stubbed, and rooms are activated with the outbox
 * repository's own PROVISIONING → ACTIVE update.
 */

let pg: PostgresProvider;
let outboxRepo: RoomLifecycleOutboxRepository;

beforeAll(() => {
    silenceNestLogger();
    pg = connectTestPostgres();
    outboxRepo = new RoomLifecycleOutboxRepository(pg);
});

afterAll(async () => {
    await pg.onModuleDestroy();
});

let owner: string;
let alice: string;
let bob: string;
let carol: string;
let movie: string;

beforeEach(async () => {
    await resetDatabase(pg);
    [owner, alice, bob, carol] = await Promise.all(
        ["owner", "alice", "bob", "carol"].map((n) => insertUser(pg, n)),
    );
    movie = await insertMovie(pg);
});

function makeService() {
    const outbox = {
        enqueueRoomReconciliation: (tx: never, roomId: string) =>
            outboxRepo.enqueueRoomReconciliation(tx, roomId),
        // Inline provisioning needs LiveKit and Redis; the room stays
        // PROVISIONING exactly as when that step fails in production.
        provisionRoomNow: jest.fn().mockRejectedValue(new Error("not in tests")),
    };
    const limiter = {
        assertAllowed: jest.fn(),
        recordFailure: jest.fn(),
        reset: jest.fn(),
    };
    return new WatchPartyService(
        new WatchPartyRepository(pg),
        outbox as unknown as RoomLifecycleOutboxService,
        limiter as unknown as AttemptLimiter,
        new BcryptPasswordHasher(),
    );
}

async function status(promise: Promise<unknown>) {
    try {
        await promise;
        return { ok: true as const };
    } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const body = error.getResponse() as { error?: { code?: string } };
        return {
            ok: false as const,
            status: error.getStatus(),
            code: typeof body === "object" ? body.error?.code : undefined,
            message: error.message,
        };
    }
}

async function room(id: string) {
    const result = await pg.query<{
        lifecycle_status: string;
        is_active: boolean;
        state_version: string;
        room_code: string;
        password: string;
        owner_id: string;
        max_participants: number;
    }>(`SELECT * FROM public.rooms WHERE id = $1`, [id]);
    return result.rows[0];
}

async function memberships(roomId: string) {
    const result = await pg.query<{
        id: string;
        user_id: string;
        is_active: boolean;
        left_at: Date | null;
    }>(
        `SELECT id, user_id, is_active, left_at FROM public.room_participants
         WHERE room_id = $1 ORDER BY joined_at, id`,
        [roomId],
    );
    return result.rows;
}

async function outboxEvents(roomId: string) {
    const result = await pg.query<{ event_type: string; status: string }>(
        `SELECT event_type, status FROM public.room_lifecycle_outbox WHERE aggregate_id = $1`,
        [roomId],
    );
    return result.rows;
}

async function activate(roomId: string) {
    const { state_version } = await room(roomId);
    const updated = await outboxRepo.activateProvisioningRoom(
        undefined,
        roomId,
        String(state_version),
    );
    expect(updated).toBe(1);
}

async function setLifecycle(roomId: string, lifecycle: string) {
    await pg.query(
        `UPDATE public.rooms SET lifecycle_status = $2::public.room_lifecycle_status,
                is_active = ($2 = 'ACTIVE') WHERE id = $1`,
        [roomId, lifecycle],
    );
}

async function createActiveRoom(
    service: WatchPartyService,
    p: { ownerId?: string; roomCode?: string; maxParticipants?: number } = {},
) {
    const created = await service.createRoomSession({
        dto: {
            passwordPlain: "room-pass",
            movieId: movie,
            roomCode: p.roomCode,
            maxParticipants: p.maxParticipants,
        },
        ownerId: p.ownerId ?? owner,
    });
    await activate(created.roomId);
    return created;
}

const join = (
    service: WatchPartyService,
    userId: string,
    roomCode: string,
    passwordPlain = "room-pass",
) => service.associateParticipant({ dto: { roomCode, passwordPlain }, userId });

describe("WatchPartyService on real Postgres", () => {
    describe("create", () => {
        it("commits a PROVISIONING room, a hashed password, the owner membership and an outbox event", async () => {
            const service = makeService();

            const created = await service.createRoomSession({
                dto: { passwordPlain: "room-pass", movieId: movie, roomCode: "ab12cd" },
                ownerId: owner,
            });

            expect(created).toMatchObject({
                roomCode: "AB12CD",
                maxParticipants: 5,
                lifecycleStatus: "PROVISIONING",
            });
            const row = await room(created.roomId);
            expect(row).toMatchObject({
                lifecycle_status: "PROVISIONING",
                is_active: false,
                owner_id: owner,
            });
            expect(await bcrypt.compare("room-pass", row.password)).toBe(true);
            expect(await memberships(created.roomId)).toEqual([
                expect.objectContaining({ user_id: owner, is_active: true }),
            ]);
            expect(await outboxEvents(created.roomId)).toEqual([
                { event_type: "ROOM_RECONCILE", status: "PENDING" },
            ]);
        });

        it("an owner with a live room gets ACTIVE_OWNER_ROOM", async () => {
            const service = makeService();
            await createActiveRoom(service);

            expect(
                await status(
                    service.createRoomSession({
                        dto: { passwordPlain: "room-pass", movieId: movie },
                        ownerId: owner,
                    }),
                ),
            ).toMatchObject({ ok: false, status: 409, code: "ACTIVE_OWNER_ROOM" });
        });

        it("two concurrent creates by one owner: the advisory lock lets exactly one through", async () => {
            const service = makeService();
            const attempt = () =>
                status(
                    service.createRoomSession({
                        dto: { passwordPlain: "room-pass", movieId: movie },
                        ownerId: owner,
                    }),
                );

            const results = await Promise.all([attempt(), attempt(), attempt()]);

            expect(results.filter((r) => r.ok)).toHaveLength(1);
            expect(results.filter((r) => !r.ok)).toEqual([
                expect.objectContaining({ status: 409, code: "ACTIVE_OWNER_ROOM" }),
                expect.objectContaining({ status: 409, code: "ACTIVE_OWNER_ROOM" }),
            ]);
            const rooms = await pg.query(`SELECT 1 FROM public.rooms WHERE owner_id = $1`, [owner]);
            expect(rooms.rowCount).toBe(1);
        });

        it("a requested code held by a live or TERMINATING room is ROOM_CODE_IN_USE; TERMINATED frees it", async () => {
            const service = makeService();
            const first = await createActiveRoom(service, { roomCode: "SAME01" });
            const second = () =>
                status(
                    service.createRoomSession({
                        dto: { passwordPlain: "room-pass", movieId: movie, roomCode: "same01" },
                        ownerId: alice,
                    }),
                );

            expect(await second()).toMatchObject({ ok: false, status: 409, code: "ROOM_CODE_IN_USE" });

            await setLifecycle(first.roomId, "TERMINATING");
            expect(await second()).toMatchObject({ ok: false, code: "ROOM_CODE_IN_USE" });

            await setLifecycle(first.roomId, "TERMINATED");
            expect(await second()).toEqual({ ok: true });
        });

        it("a member of another live room cannot create one (ACTIVE_MEMBERSHIP_ELSEWHERE)", async () => {
            const service = makeService();
            const hosted = await createActiveRoom(service);
            await join(service, alice, hosted.roomCode);

            const result = await status(
                service.createRoomSession({
                    dto: { passwordPlain: "room-pass", movieId: movie },
                    ownerId: alice,
                }),
            );

            expect(result).toMatchObject({
                ok: false,
                status: 409,
                code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                message: `You are still in room ${hosted.roomCode}. Leave it before joining another room.`,
            });
        });

        it("after the owner closes a room, they can create another while it is TERMINATING", async () => {
            const service = makeService();
            const first = await createActiveRoom(service);
            await service.leaveRoomSession(owner, first.roomId);

            expect((await room(first.roomId)).lifecycle_status).toBe("TERMINATING");
            expect(
                await status(
                    service.createRoomSession({
                        dto: { passwordPlain: "room-pass", movieId: movie },
                        ownerId: owner,
                    }),
                ),
            ).toEqual({ ok: true });
        });
    });

    describe("join", () => {
        it("a PROVISIONING room answers 503 until the outbox activates it", async () => {
            const service = makeService();
            const created = await service.createRoomSession({
                dto: { passwordPlain: "room-pass", movieId: movie },
                ownerId: owner,
            });

            expect(await status(join(service, alice, created.roomCode))).toMatchObject({
                ok: false,
                status: 503,
            });

            await activate(created.roomId);
            expect(await status(join(service, alice, created.roomCode))).toEqual({ ok: true });
        });

        it("an unknown or TERMINATED room code is 404", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            await setLifecycle(created.roomId, "TERMINATED");

            expect(await status(join(service, alice, created.roomCode))).toMatchObject({
                status: 404,
            });
            expect(await status(join(service, alice, "NOPE00"))).toMatchObject({ status: 404 });
        });

        it("a first join creates a membership, bumps state_version and enqueues reconciliation", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            const before = Number((await room(created.roomId)).state_version);

            const joined = await join(service, alice, created.roomCode.toLowerCase());

            expect(joined).toMatchObject({
                createdMembership: true,
                roomId: created.roomId,
                participantCount: 2,
                lifecycleVersion: String(before + 1),
            });
            expect(Number((await room(created.roomId)).state_version)).toBe(before + 1);
            expect((await outboxEvents(created.roomId)).length).toBe(2);
        });

        it("a wrong password is 400 and leaves no membership", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);

            expect(await status(join(service, alice, created.roomCode, "wrong"))).toMatchObject({
                status: 400,
                message: "Security credentials verification failure: Authentication rejected.",
            });
            expect((await memberships(created.roomId)).map((m) => m.user_id)).toEqual([owner]);
        });

        it("a reconnect reuses the active row without a password or version bump", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            const first = await join(service, alice, created.roomCode);
            const version = (await room(created.roomId)).state_version;

            const again = await join(service, alice, created.roomCode, "");

            expect(again).toMatchObject({
                participantId: first.participantId,
                createdMembership: false,
            });
            expect(await memberships(created.roomId)).toHaveLength(2);
            expect((await room(created.roomId)).state_version).toBe(version);
        });

        it("a full room is 400; the owner and existing members still get in", async () => {
            const service = makeService();
            const created = await createActiveRoom(service, { maxParticipants: 2 });
            await join(service, alice, created.roomCode);

            expect(await status(join(service, bob, created.roomCode))).toMatchObject({
                status: 400,
                message: "Room capacity overflow limit reached. Cap: 2",
            });
            expect(await status(join(service, alice, created.roomCode))).toEqual({ ok: true });
            expect(await status(join(service, owner, created.roomCode, ""))).toEqual({ ok: true });
        });

        it("concurrent joins for the last slot: the room row lock admits exactly one", async () => {
            const service = makeService();
            const created = await createActiveRoom(service, { maxParticipants: 2 });

            const results = await Promise.all(
                [alice, bob, carol].map((u) => status(join(service, u, created.roomCode))),
            );

            expect(results.filter((r) => r.ok)).toHaveLength(1);
            expect(results.filter((r) => !r.ok)).toEqual([
                expect.objectContaining({ status: 400 }),
                expect.objectContaining({ status: 400 }),
            ]);
            expect((await memberships(created.roomId)).filter((m) => m.is_active)).toHaveLength(2);
        });

        it("a member of room A joining room B gets ACTIVE_MEMBERSHIP_ELSEWHERE naming A", async () => {
            const service = makeService();
            const roomA = await createActiveRoom(service);
            const roomB = await createActiveRoom(service, { ownerId: bob });
            await join(service, alice, roomA.roomCode);

            const result = await status(join(service, alice, roomB.roomCode));

            expect(result).toMatchObject({
                status: 409,
                code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                message: `You are still in room ${roomA.roomCode}. Leave it before joining another room.`,
            });
        });

        it("one user joining two rooms at once ends up in exactly one", async () => {
            const service = makeService();
            const roomA = await createActiveRoom(service);
            const roomB = await createActiveRoom(service, { ownerId: bob });

            const results = await Promise.all([
                status(join(service, alice, roomA.roomCode)),
                status(join(service, alice, roomB.roomCode)),
            ]);

            expect(results.filter((r) => r.ok)).toHaveLength(1);
            expect(results.find((r) => !r.ok)).toMatchObject({ status: 409 });
            const active = await pg.query(
                `SELECT 1 FROM public.room_participants WHERE user_id = $1 AND is_active`,
                [alice],
            );
            expect(active.rowCount).toBe(1);
        });
    });

    describe("leave and grace expiry", () => {
        it("participant leave deactivates only that membership and records left_at", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            await join(service, alice, created.roomCode);

            expect(await service.leaveRoomSession(alice)).toMatchObject({
                status: "PARTICIPANT_EVICTED",
                participantCount: 1,
            });
            const rows = await memberships(created.roomId);
            expect(rows.find((m) => m.user_id === alice)).toMatchObject({ is_active: false });
            expect(rows.find((m) => m.user_id === alice)?.left_at).toBeInstanceOf(Date);
            expect(rows.find((m) => m.user_id === owner)).toMatchObject({ is_active: true });
            expect((await room(created.roomId)).lifecycle_status).toBe("ACTIVE");
        });

        it("owner leave moves the room to TERMINATING and ends every membership", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            await join(service, alice, created.roomCode);

            const result = await service.leaveRoomSession(owner, created.roomId);

            expect(result).toMatchObject({ status: "ROOM_DESTROYED", participantCount: 0 });
            expect([...(result.membersToKick ?? [])].sort()).toEqual([alice, owner].sort());
            expect(await room(created.roomId)).toMatchObject({
                lifecycle_status: "TERMINATING",
                is_active: false,
            });
            expect((await memberships(created.roomId)).every((m) => !m.is_active)).toBe(true);
        });

        it("a retried owner leave reports ROOM_ALREADY_TERMINATING; others get NO_ACTIVE_SESSION", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            await service.leaveRoomSession(owner, created.roomId);

            expect(await service.leaveRoomSession(owner, created.roomId)).toMatchObject({
                status: "ROOM_ALREADY_TERMINATING",
                roomId: created.roomId,
            });
            expect(await service.leaveRoomSession(alice, created.roomId)).toEqual({
                status: "NO_ACTIVE_SESSION",
            });
        });

        it("grace expiry deactivates once; a second run is a no-op", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            const joined = await join(service, alice, created.roomCode);

            expect(await service.disassociateParticipant(joined.participantId)).toEqual({
                roomId: created.roomId,
                roomCode: created.roomCode,
                participantCount: 1,
            });
            expect(await service.disassociateParticipant(joined.participantId)).toBeNull();
        });

        it("grace expiry does nothing once the room is no longer ACTIVE", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            const joined = await join(service, alice, created.roomCode);
            await setLifecycle(created.roomId, "TERMINATING");

            expect(await service.disassociateParticipant(joined.participantId)).toBeNull();
            expect(
                (await memberships(created.roomId)).find((m) => m.user_id === alice)?.is_active,
            ).toBe(true);
        });
    });

    describe("queries", () => {
        it("room details, active memberships and the projection read the same rows", async () => {
            const service = makeService();
            const created = await createActiveRoom(service);
            await join(service, alice, created.roomCode);

            expect(await service.getRoomDetailsByCode(created.roomCode.toLowerCase())).toMatchObject({
                roomId: created.roomId,
                roomCode: created.roomCode,
            });
            expect(
                (await service.listActiveMemberships())
                    .map((m) => ({ userId: m.userId, isOwner: m.isOwner }))
                    .sort((a, b) => a.userId.localeCompare(b.userId)),
            ).toEqual(
                [
                    { userId: owner, isOwner: true },
                    { userId: alice, isOwner: false },
                ].sort((a, b) => a.userId.localeCompare(b.userId)),
            );
            expect(await service.getRoomProjectionState(created.roomId)).toMatchObject({
                roomId: created.roomId,
                lifecycleStatus: "ACTIVE",
                participantCount: 2,
                maxParticipants: 5,
            });
            await expect(service.assertRoomActive(created.roomId)).resolves.toBeUndefined();

            await setLifecycle(created.roomId, "TERMINATING");
            expect(await service.getRoomDetailsByCode(created.roomCode)).toBeNull();
            expect(await status(service.assertRoomActive(created.roomId))).toMatchObject({
                status: 409,
            });
        });
    });
});
