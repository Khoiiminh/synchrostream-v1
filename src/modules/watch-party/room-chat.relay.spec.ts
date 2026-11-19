import { Logger } from "@nestjs/common";
import { RoomChatRelay } from "./room-chat.relay.js";
import type { ChatStore } from "./application/ports/collaborators.port.js";
import { CHAT_HISTORY_LIMIT, CHAT_RATE_RULE } from "./domain/chat-policy.js";

/*
 * Characterization tests for RoomChatRelay (written with phase 2, when chat
 * came into the refactor's scope). The store is mocked; SQL is covered by
 * room-chat.repository.int-spec.ts.
 */

function setup() {
    const store = {
        insertMessage: jest.fn(async () => ({
            id: "41",
            sent_at: new Date(5_000),
        })),
        findRecentMessages: jest.fn(async () => []),
    };
    const relay = new RoomChatRelay(store as unknown as ChatStore);
    return { relay, store };
}

const send = (
    relay: RoomChatRelay,
    over: Partial<Parameters<RoomChatRelay["submit"]>[0]> = {},
) =>
    relay.submit({
        roomId: "room-1",
        userId: "user-1",
        username: "alice",
        rawMessage: "  hello  ",
        rawClientMessageId: "client-1",
        ...over,
    });

beforeAll(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

beforeEach(() => {
    jest.useFakeTimers({ now: 1_000 });
});

afterEach(() => {
    jest.useRealTimers();
});

describe("RoomChatRelay.submit", () => {
    it("normalizes, persists and returns the broadcast payload", async () => {
        const { relay, store } = setup();

        expect(await send(relay)).toEqual({
            accepted: true,
            payload: {
                id: "41",
                userId: "user-1",
                username: "alice",
                message: "hello",
                timestamp: 5_000,
                clientMessageId: "client-1",
            },
        });
        expect(store.insertMessage).toHaveBeenCalledWith({
            roomId: "room-1",
            userId: "user-1",
            senderName: "alice",
            message: "hello",
        });
    });

    it("truncates the stored sender name to 50 code points", async () => {
        const { relay, store } = setup();
        await send(relay, { username: "😀".repeat(60) });

        expect(store.insertMessage).toHaveBeenCalledWith(
            expect.objectContaining({ senderName: "😀".repeat(50) }),
        );
    });

    it("drops an invalid client message id instead of rejecting", async () => {
        const { relay } = setup();
        const result = await send(relay, { rawClientMessageId: "bad id!" });

        expect(result).toMatchObject({
            accepted: true,
            payload: { clientMessageId: null },
        });
    });

    it.each([
        ["not text", 42, "Message must be text."],
        ["blank", "   ", "Message is empty."],
        ["too long", "x".repeat(501), "Message is longer than 500 characters."],
    ])("rejects a %s message without persisting or counting it", async (_l, raw, reason) => {
        const { relay, store } = setup();

        expect(await send(relay, { rawMessage: raw })).toEqual({
            accepted: false,
            ack: { ok: false, code: "INVALID_MESSAGE", message: reason },
        });
        expect(store.insertMessage).not.toHaveBeenCalled();

        // Not counted: a full allowance of valid messages still goes through.
        for (let i = 0; i < CHAT_RATE_RULE.max; i += 1) {
            expect((await send(relay)).accepted).toBe(true);
        }
    });

    it("rate-limits per sender per room and recovers after the window", async () => {
        const { relay, store } = setup();
        for (let i = 0; i < CHAT_RATE_RULE.max; i += 1) await send(relay);

        jest.setSystemTime(1_000 + 4_000);
        expect(await send(relay)).toEqual({
            accepted: false,
            ack: {
                ok: false,
                code: "RATE_LIMITED",
                message: "You are sending messages too quickly.",
                retryAfterMs: CHAT_RATE_RULE.windowMs - 4_000,
            },
        });
        expect(store.insertMessage).toHaveBeenCalledTimes(CHAT_RATE_RULE.max);

        // Other senders and other rooms have their own windows.
        expect((await send(relay, { userId: "user-2" })).accepted).toBe(true);
        expect((await send(relay, { roomId: "room-2" })).accepted).toBe(true);

        jest.setSystemTime(1_000 + CHAT_RATE_RULE.windowMs);
        expect((await send(relay)).accepted).toBe(true);
    });

    it("still relays live (id null, server time) when persistence fails", async () => {
        const { relay, store } = setup();
        store.insertMessage.mockRejectedValue(new Error("db down"));

        expect(await send(relay)).toEqual({
            accepted: true,
            payload: {
                id: null,
                userId: "user-1",
                username: "alice",
                message: "hello",
                timestamp: 1_000,
                clientMessageId: "client-1",
            },
        });
    });
});

describe("RoomChatRelay.getRecentHistory", () => {
    it("maps stored rows, oldest first, with no client ids", async () => {
        const { relay, store } = setup();
        store.findRecentMessages.mockResolvedValue([
            {
                id: "1",
                user_id: "user-1",
                sender_name_at_time: "alice",
                message: "first",
                sent_at: new Date(10),
            },
            {
                id: "2",
                user_id: null,
                sender_name_at_time: null,
                message: "second",
                sent_at: new Date(20),
            },
        ] as never);

        expect(await relay.getRecentHistory("room-1")).toEqual([
            { id: "1", userId: "user-1", username: "alice", message: "first", timestamp: 10, clientMessageId: null },
            { id: "2", userId: null, username: "Unknown", message: "second", timestamp: 20, clientMessageId: null },
        ]);
        expect(store.findRecentMessages).toHaveBeenCalledWith("room-1", CHAT_HISTORY_LIMIT);
    });
});
