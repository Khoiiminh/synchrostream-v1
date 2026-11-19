/**
 * Pure chat rules: message normalization and the per-sender rate window.
 * No state lives here; RoomChatRelay owns the windows and calls these.
 */

/** Longest message accepted, in Unicode code points (after trimming). */
export const CHAT_MESSAGE_MAX_LENGTH = 500;

/** How many past messages a member receives when it binds to a room. */
export const CHAT_HISTORY_LIMIT = 50;

/** Fixed window: at most `max` messages per sender per room every `windowMs`. */
export const CHAT_RATE_RULE = { max: 10, windowMs: 10_000 } as const;

/** `sender_name_at_time` is varchar(50). */
export const CHAT_SENDER_NAME_MAX_LENGTH = 50;

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * C0/C1 control characters except tab and newline. They have no visual use in
 * chat and can break log lines and terminal output.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export type NormalizedChatMessage =
    | { ok: true; text: string }
    | { ok: false; reason: string };

/** Trims, strips control characters and enforces the length limits. */
export function normalizeChatMessage(raw: unknown): NormalizedChatMessage {
    if (typeof raw !== "string") {
        return { ok: false, reason: "Message must be text." };
    }

    const text = raw
        .replace(/\r\n?/g, "\n")
        .replace(CONTROL_CHARACTERS, "")
        .trim();

    if (text.length === 0) {
        return { ok: false, reason: "Message is empty." };
    }

    if ([...text].length > CHAT_MESSAGE_MAX_LENGTH) {
        return {
            ok: false,
            reason: `Message is longer than ${CHAT_MESSAGE_MAX_LENGTH} characters.`,
        };
    }

    return { ok: true, text };
}

/** The client's id for its optimistic message, echoed back so it can match the broadcast. */
export function normalizeClientMessageId(raw: unknown): string | null {
    return typeof raw === "string" && CLIENT_MESSAGE_ID_PATTERN.test(raw)
        ? raw
        : null;
}

/** Truncates by code point so a surrogate pair is never split. */
export function toSenderNameAtTime(username: string): string {
    return [...username].slice(0, CHAT_SENDER_NAME_MAX_LENGTH).join("");
}

export interface ChatRateWindow {
    startedAt: number;
    count: number;
}

export type ChatRateDecision =
    | { allowed: true; window: ChatRateWindow }
    | { allowed: false; window: ChatRateWindow; retryAfterMs: number };

/**
 * Counts one message against the sender's window. The first message opens the
 * window; later ones do not extend it (same semantics as AttemptLimiter).
 */
export function consumeChatAllowance(
    window: ChatRateWindow | undefined,
    now: number,
    rule: { max: number; windowMs: number } = CHAT_RATE_RULE,
): ChatRateDecision {
    if (!window || now - window.startedAt >= rule.windowMs) {
        return { allowed: true, window: { startedAt: now, count: 1 } };
    }

    if (window.count >= rule.max) {
        return {
            allowed: false,
            window,
            retryAfterMs: Math.max(rule.windowMs - (now - window.startedAt), 1),
        };
    }

    return {
        allowed: true,
        window: { startedAt: window.startedAt, count: window.count + 1 },
    };
}

/** True once a window can no longer limit anything and may be dropped. */
export function isChatRateWindowExpired(
    window: ChatRateWindow,
    now: number,
    rule: { windowMs: number } = CHAT_RATE_RULE,
): boolean {
    return now - window.startedAt >= rule.windowMs;
}
