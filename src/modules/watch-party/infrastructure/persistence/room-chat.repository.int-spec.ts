import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { RoomChatRepository } from "./room-chat.repository.js";
import {
    connectTestPostgres,
    insertMovie,
    insertUser,
    resetDatabase,
} from "../../../../../test/integration/fixtures.js";

/* chat_history SQL against the disposable Postgres (see test/integration). */

let pg: PostgresProvider;
let repo: RoomChatRepository;
let roomId: string;
let otherRoomId: string;
let userId: string;

beforeAll(() => {
    pg = connectTestPostgres();
    repo = new RoomChatRepository(pg);
});

afterAll(async () => {
    await pg.onModuleDestroy();
});

beforeEach(async () => {
    await resetDatabase(pg);
    userId = await insertUser(pg, "alice");
    const movieId = await insertMovie(pg);
    const rooms = await pg.query<{ id: string }>(
        `INSERT INTO public.rooms (room_code, "password", owner_id, movie_id)
         VALUES ('CHAT01', 'x', $1, $2), ('CHAT02', 'x', $1, $2) RETURNING id`,
        [userId, movieId],
    );
    [roomId, otherRoomId] = rooms.rows.map((r) => r.id);
});

describe("RoomChatRepository on real Postgres", () => {
    it("inserts a message and returns its BIGINT id as a string with the server time", async () => {
        const row = await repo.insertMessage({
            roomId,
            userId,
            senderName: "alice",
            message: "hello",
        });

        expect(row.id).toBe("1");
        expect(row.sent_at).toBeInstanceOf(Date);
    });

    it("returns the latest messages of one room, oldest first, up to the limit", async () => {
        for (const message of ["one", "two", "three", "four"]) {
            await repo.insertMessage({
                roomId,
                userId,
                senderName: "alice",
                message,
            });
        }
        await repo.insertMessage({
            roomId: otherRoomId,
            userId,
            senderName: "alice",
            message: "elsewhere",
        });

        const rows = await repo.findRecentMessages(roomId, 3);

        expect(rows.map((r) => r.message)).toEqual(["two", "three", "four"]);
        expect(rows[0]).toMatchObject({
            user_id: userId,
            sender_name_at_time: "alice",
        });
        expect(typeof rows[0].id).toBe("string");
    });

    it("keeps a deleted sender's messages with user_id null and their name at the time", async () => {
        // The room belongs to alice; the sender is a separate account.
        const sender = await insertUser(pg, "sender2");
        await repo.insertMessage({
            roomId,
            userId: sender,
            senderName: "sender2",
            message: "kept",
        });

        await pg.query(`DELETE FROM public.users WHERE id = $1`, [sender]);

        expect(await repo.findRecentMessages(roomId, 10)).toEqual([
            expect.objectContaining({
                message: "kept",
                user_id: null,
                sender_name_at_time: "sender2",
            }),
        ]);
    });
});
