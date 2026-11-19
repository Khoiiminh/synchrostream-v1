import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { RoomAccessQuery } from "./room-access.query.js";
import { MediaSessionEvents } from "./media-session-events.js";
import {
    connectTestPostgres,
    insertMovie,
    insertUser,
    resetDatabase,
} from "../../../../test/integration/fixtures.js";

/*
 * Watch-party's cross-module contract on the disposable Postgres (phase 5).
 * LiveKit and media sessions now read rooms/memberships and enqueue outbox
 * events only through these classes.
 */

let pg: PostgresProvider;
let rooms: RoomAccessQuery;
let events: MediaSessionEvents;
let owner: string;
let member: string;
let movie: string;

beforeAll(() => {
    pg = connectTestPostgres();
    rooms = new RoomAccessQuery(pg);
    events = new MediaSessionEvents();
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

async function insertRoom(lifecycle: string, code = "ROOM01") {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.rooms (room_code, "password", owner_id, movie_id, max_participants,
                                   lifecycle_status, is_active)
         VALUES ($1, 'x', $2, $3, 4, $4::public.room_lifecycle_status, $4 = 'ACTIVE') RETURNING id`,
        [code, owner, movie, lifecycle],
    );
    return rows[0].id;
}

async function addMember(roomId: string, userId: string, active = true) {
    const { rows } = await pg.query<{ id: string }>(
        `INSERT INTO public.room_participants (room_id, user_id, is_active)
         VALUES ($1, $2, $3) RETURNING id`,
        [roomId, userId, active],
    );
    return rows[0].id;
}

const MISSING = "00000000-0000-4000-8000-000000000000";

describe("RoomAccessQuery", () => {
    it("ACTIVE room: every read sees it and its active member", async () => {
        const roomId = await insertRoom("ACTIVE");
        const membershipId = await addMember(roomId, member);

        expect(await rooms.findActiveMembershipId(roomId, member)).toBe(membershipId);
        expect(await rooms.isRoomActive(roomId)).toBe(true);
        expect(await rooms.findActiveRoomId(roomId)).toBe(roomId);
        expect(await rooms.findActiveParticipant(roomId, member)).toEqual({
            participant_id: membershipId,
            user_id: member,
            room_id: roomId,
        });
        expect(await rooms.findActiveRoom(roomId)).toEqual({ id: roomId, max_participants: 4 });
        expect(await rooms.findRoomActivity(roomId)).toEqual({ id: roomId, is_active: true });
    });

    it.each(["PROVISIONING", "TERMINATING", "TERMINATED"])(
        "%s room: the ACTIVE-only reads see nothing",
        async (lifecycle) => {
            const roomId = await insertRoom(lifecycle);
            await addMember(roomId, member);

            expect(await rooms.findActiveMembershipId(roomId, member)).toBeUndefined();
            expect(await rooms.isRoomActive(roomId)).toBe(false);
            expect(await rooms.findActiveRoomId(roomId)).toBeUndefined();
            expect(await rooms.findActiveParticipant(roomId, member)).toBeUndefined();
            expect(await rooms.findActiveRoom(roomId)).toBeUndefined();
            expect(await rooms.findRoomActivity(roomId)).toEqual({ id: roomId, is_active: false });
        },
    );

    it("an inactive membership is not an active member, but is still found as a participant", async () => {
        const roomId = await insertRoom("ACTIVE");
        const membershipId = await addMember(roomId, member, false);

        expect(await rooms.findActiveMembershipId(roomId, member)).toBeUndefined();
        expect(await rooms.findActiveParticipant(roomId, member)).toBeUndefined();
        expect(await rooms.findRoomParticipant(roomId, member)).toEqual({
            participant_id: membershipId,
            user_id: member,
            room_id: roomId,
        });
    });

    it("unknown rooms and users read as absent", async () => {
        expect(await rooms.findActiveRoom(MISSING)).toBeUndefined();
        expect(await rooms.findRoomActivity(MISSING)).toBeUndefined();
        expect(await rooms.findRoomParticipant(MISSING, member)).toBeUndefined();
        expect(await rooms.isRoomActive(MISSING)).toBe(false);
    });

    it("lockActiveRoom holds an ACTIVE room's row until the transaction ends; other states are not found", async () => {
        const active = await insertRoom("ACTIVE");
        const terminating = await insertRoom("TERMINATING", "ROOM02");
        const order: string[] = [];

        let signalLocked!: () => void;
        const firstHasLock = new Promise<void>((resolve) => (signalLocked = resolve));
        let release!: () => void;
        const releaseFirst = new Promise<void>((resolve) => (release = resolve));

        const first = pg.withTransaction(async (tx) => {
            expect(await rooms.lockActiveRoom(tx, active)).toBe(true);
            expect(await rooms.lockActiveRoom(tx, terminating)).toBe(false);
            signalLocked();
            await releaseFirst;
            order.push("first commits");
        });
        await firstHasLock;

        const second = pg.withTransaction(async (tx) => {
            await rooms.lockActiveRoom(tx, active);
            order.push("second locked");
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(order).toEqual([]); // second is blocked on the row lock
        } finally {
            // Always release, so a failed assertion cannot leave a transaction
            // (and the pool) open and hang the run.
            release();
            await Promise.allSettled([first, second]);
        }
        expect(order).toEqual(["first commits", "second locked"]);
    });
});

describe("MediaSessionEvents", () => {
    it("enqueues an immediate and a delayed LIVEKIT_SESSION_RECONCILE in the caller's transaction", async () => {
        const immediate = "11111111-1111-4111-8111-111111111111";
        const delayed = "22222222-2222-4222-8222-222222222222";

        await pg.withTransaction(async (tx) => {
            await events.enqueueSessionReconcile(tx, immediate);
            await events.enqueueDelayedSessionReconcile(tx, delayed);
        });

        const { rows } = await pg.query<{ aggregate_id: string; status: string; due_now: boolean; delay_s: number }>(
            `SELECT aggregate_id, status, next_attempt_at <= NOW() AS due_now,
                    ROUND(EXTRACT(EPOCH FROM next_attempt_at - created_at))::int AS delay_s
             FROM public.room_lifecycle_outbox WHERE event_type = 'LIVEKIT_SESSION_RECONCILE'
             ORDER BY delay_s`,
        );
        expect(rows).toEqual([
            { aggregate_id: immediate, status: "PENDING", due_now: true, delay_s: 0 },
            { aggregate_id: delayed, status: "PENDING", due_now: false, delay_s: 35 },
        ]);
    });

    it("rolls back with the caller's transaction", async () => {
        await pg
            .withTransaction(async (tx) => {
                await events.enqueueSessionReconcile(tx, "33333333-3333-4333-8333-333333333333");
                throw new Error("caller failed");
            })
            .catch(() => undefined);

        const { rows } = await pg.query(`SELECT 1 FROM public.room_lifecycle_outbox`);
        expect(rows).toHaveLength(0);
    });
});
