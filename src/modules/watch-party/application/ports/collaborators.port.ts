import type {
    ChatHistoryRow,
    InsertedChatRow,
} from "../../watch-party.types.js";
import type { Tx } from "./transaction.js";

/** Hashes and checks room passwords. Adapter: bcrypt. */
export interface PasswordHasher {
    hash(plain: string): Promise<string>;
    compare(plain: string, hash: string): Promise<boolean>;
}

/** A fixed-window attempt limit (prefix, max attempts, window). */
export interface AttemptRule {
    readonly prefix: string;
    readonly max: number;
    readonly windowSeconds: number;
}

/**
 * Wrong-password limiting. Adapter: the shared Redis AttemptLimiter, which
 * fails open when Redis is unavailable.
 */
export interface AttemptLimiterPort {
    /** @throws an HTTP 429 once the limit is reached. */
    assertAllowed(rule: AttemptRule, id: string): Promise<void>;
    recordFailure(rule: AttemptRule, id: string): Promise<void>;
    reset(rule: AttemptRule, id: string): Promise<void>;
}

/** Durable room reconciliation. Adapter: RoomLifecycleOutboxService. */
export interface LifecycleOutboxPort {
    /** Inside the caller's transaction, so the event commits with the change. */
    enqueueRoomReconciliation(tx: Tx, roomId: string): Promise<void>;
    /** Best-effort fast path after commit; the outbox event is the guarantee. */
    provisionRoomNow(roomId: string): Promise<void>;
}

/** Media-provider sessions. Adapter: LiveKitService. */
export interface MediaSessionPort {
    /** Starts (or returns) the room's ACTIVE session; used by the gateway's background startup. */
    getOrCreateMediaSession(roomId: string): Promise<{ id: string }>;
    reconcileMediaSession(
        mediaSessionId: string,
        recoveryStartedAt: Date | string,
    ): Promise<void>;
    endMediaSessionForRoom(roomId: string): Promise<void>;
    reconcileRoomParticipants(
        roomId: string,
        loadAllowedIdentities: () => Promise<ReadonlySet<string>>,
    ): Promise<void>;
}

/**
 * The room's shared runtime projection (identity- and version-checked).
 * Adapter: RedisProvider.
 */
export interface RoomStateProjectionPort {
    reconcileRoomState(
        roomCode: string,
        state: Record<string, string | number>,
    ): Promise<boolean>;
    replaceStaleRoomState(
        roomCode: string,
        staleRoomId: string,
        state: Record<string, string | number>,
    ): Promise<boolean>;
    getRoomState(roomCode: string): Promise<Record<string, string>>;
}

/** Per-member presence keys with a TTL. Adapter: RedisProvider. */
export interface PresencePort {
    refreshPresence(
        members: Array<{ roomId: string; userId: string }>,
        ttlSeconds: number,
    ): Promise<void>;
    getPresence(
        members: Array<{ roomId: string; userId: string }>,
    ): Promise<boolean[]>;
    clearPresence(roomId: string, userId: string): Promise<void>;
}

/**
 * Everything the realtime gateway reads and writes in the shared runtime
 * store: the room projection, playback writes, sync pulses and presence.
 * Adapter: RedisProvider.
 */
export interface RealtimeStatePort
    extends RoomStateProjectionPort, PresencePort {
    /** Playback write, accepted only while `expectedRoomId` owns the key. */
    updateRoomState(
        roomCode: string,
        state: Record<string, string | number>,
        expectedRoomId: string,
    ): Promise<boolean>;
    publicSyncPulse(roomCode: string, payload: unknown): Promise<void>;
}

/** chat_history persistence. Adapter: RoomChatRepository. */
export interface ChatStore {
    insertMessage(message: {
        roomId: string;
        userId: string;
        senderName: string;
        message: string;
    }): Promise<InsertedChatRow>;
    /** The room's latest `limit` messages, oldest first. */
    findRecentMessages(
        roomId: string,
        limit: number,
    ): Promise<ChatHistoryRow[]>;
}
