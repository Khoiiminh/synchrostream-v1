import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import type { ChatStore } from "./application/ports/collaborators.port.js";
import { CHAT_STORE } from "./application/ports/tokens.js";
import {
    CHAT_HISTORY_LIMIT,
    CHAT_RATE_RULE,
    consumeChatAllowance,
    isChatRateWindowExpired,
    normalizeChatMessage,
    normalizeClientMessageId,
    toSenderNameAtTime,
    type ChatRateWindow,
} from "./domain/chat-policy.js";
import type { ChatMessagePayload, ChatSendAck } from "./watch-party.types.js";

/** How often expired rate windows are dropped. */
const RATE_WINDOW_PRUNE_MS = 60_000;

export type ChatSubmitResult =
    | { accepted: true; payload: ChatMessagePayload }
    | { accepted: false; ack: Extract<ChatSendAck, { ok: false }> };

/**
 * Stateful actor for room chat. Owns the per-sender rate windows and is the
 * only way a message gets into `chat_history`. The gateway handles transport:
 * it asks the relay to accept a message and then broadcasts what comes back.
 *
 * Rate windows are in-process, matching the gateway's single-instance rule.
 */
@Injectable()
export class RoomChatRelay implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RoomChatRelay.name);

    /** `${roomId}:${userId}` -> current fixed window. */
    readonly #rateWindows = new Map<string, ChatRateWindow>();

    #pruneTimer?: NodeJS.Timeout;

    constructor(@Inject(CHAT_STORE) private readonly repository: ChatStore) {}

    onModuleInit(): void {
        this.#pruneTimer = setInterval(
            () => this.pruneRateWindows(Date.now()),
            RATE_WINDOW_PRUNE_MS,
        );
        this.#pruneTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    }

    /**
     * Validates, rate-limits and persists one message. Persistence is
     * best-effort: if PostgreSQL fails, the message is still accepted for the
     * live broadcast (with `id: null`) so chat keeps working during a DB blip.
     */
    async submit(params: {
        roomId: string;
        userId: string;
        username: string;
        rawMessage: unknown;
        rawClientMessageId: unknown;
    }): Promise<ChatSubmitResult> {
        const normalized = normalizeChatMessage(params.rawMessage);
        if (!normalized.ok) {
            return {
                accepted: false,
                ack: {
                    ok: false,
                    code: "INVALID_MESSAGE",
                    message: normalized.reason,
                },
            };
        }

        const now = Date.now();
        const rateKey = `${params.roomId}:${params.userId}`;
        const decision = consumeChatAllowance(
            this.#rateWindows.get(rateKey),
            now,
            CHAT_RATE_RULE,
        );
        this.#rateWindows.set(rateKey, decision.window);

        if (!decision.allowed) {
            return {
                accepted: false,
                ack: {
                    ok: false,
                    code: "RATE_LIMITED",
                    message: "You are sending messages too quickly.",
                    retryAfterMs: decision.retryAfterMs,
                },
            };
        }

        const clientMessageId = normalizeClientMessageId(
            params.rawClientMessageId,
        );

        let id: string | null = null;
        let timestamp = now;

        try {
            const row = await this.repository.insertMessage({
                roomId: params.roomId,
                userId: params.userId,
                senderName: toSenderNameAtTime(params.username),
                message: normalized.text,
            });
            id = row.id;
            timestamp = row.sent_at.getTime();
        } catch (error) {
            this.logger.warn({
                message:
                    "Failed to persist chat message; relaying it live only",
                roomId: params.roomId,
                userId: params.userId,
                err: error,
            });
        }

        return {
            accepted: true,
            payload: {
                id,
                userId: params.userId,
                username: params.username,
                message: normalized.text,
                timestamp,
                clientMessageId,
            },
        };
    }

    /** The room's recent persisted messages, oldest first. */
    async getRecentHistory(roomId: string): Promise<ChatMessagePayload[]> {
        const rows = await this.repository.findRecentMessages(
            roomId,
            CHAT_HISTORY_LIMIT,
        );

        return rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            username: row.sender_name_at_time ?? "Unknown",
            message: row.message,
            timestamp: row.sent_at.getTime(),
            clientMessageId: null,
        }));
    }

    private pruneRateWindows(now: number): void {
        for (const [key, window] of this.#rateWindows) {
            if (isChatRateWindowExpired(window, now, CHAT_RATE_RULE)) {
                this.#rateWindows.delete(key);
            }
        }
    }
}
