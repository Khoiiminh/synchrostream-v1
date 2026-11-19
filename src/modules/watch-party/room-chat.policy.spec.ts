import {
    CHAT_MESSAGE_MAX_LENGTH,
    consumeChatAllowance,
    isChatRateWindowExpired,
    normalizeChatMessage,
    normalizeClientMessageId,
    toSenderNameAtTime,
} from "./room-chat.policy.js";

describe("normalizeChatMessage", () => {
    it("trims and keeps newlines", () => {
        expect(normalizeChatMessage("  hi\r\nthere  ")).toEqual({
            ok: true,
            text: "hi\nthere",
        });
    });

    it("strips control characters", () => {
        expect(normalizeChatMessage("a\u0000b\u001bc")).toEqual({
            ok: true,
            text: "abc",
        });
    });

    it("rejects non-strings and blank text", () => {
        expect(normalizeChatMessage(42).ok).toBe(false);
        expect(normalizeChatMessage("   ").ok).toBe(false);
        expect(normalizeChatMessage("\u0000").ok).toBe(false);
    });

    it("counts code points against the limit", () => {
        const emoji = "😀".repeat(CHAT_MESSAGE_MAX_LENGTH);
        expect(normalizeChatMessage(emoji).ok).toBe(true);
        expect(normalizeChatMessage(emoji + "x").ok).toBe(false);
    });
});

describe("normalizeClientMessageId", () => {
    it("accepts short url-safe ids only", () => {
        expect(normalizeClientMessageId("abc-123_X")).toBe("abc-123_X");
        expect(normalizeClientMessageId("a b")).toBeNull();
        expect(normalizeClientMessageId("x".repeat(65))).toBeNull();
        expect(normalizeClientMessageId(undefined)).toBeNull();
    });
});

describe("toSenderNameAtTime", () => {
    it("truncates to 50 code points", () => {
        expect([...toSenderNameAtTime("😀".repeat(60))]).toHaveLength(50);
    });
});

describe("consumeChatAllowance", () => {
    const rule = { max: 2, windowMs: 1000 };

    it("opens a window, counts, then blocks until it expires", () => {
        const first = consumeChatAllowance(undefined, 0, rule);
        expect(first).toEqual({
            allowed: true,
            window: { startedAt: 0, count: 1 },
        });

        const second = consumeChatAllowance(first.window, 100, rule);
        expect(second.allowed).toBe(true);

        const third = consumeChatAllowance(second.window, 400, rule);
        expect(third).toEqual({
            allowed: false,
            window: { startedAt: 0, count: 2 },
            retryAfterMs: 600,
        });

        const afterWindow = consumeChatAllowance(third.window, 1000, rule);
        expect(afterWindow).toEqual({
            allowed: true,
            window: { startedAt: 1000, count: 1 },
        });
    });

    it("reports expiry", () => {
        expect(
            isChatRateWindowExpired({ startedAt: 0, count: 2 }, 999, rule),
        ).toBe(false);
        expect(
            isChatRateWindowExpired({ startedAt: 0, count: 2 }, 1000, rule),
        ).toBe(true);
    });
});
