/** Nest injection tokens for the watch-party ports (bound in watch-party.module.ts). */
export const WATCH_PARTY_STORE = Symbol("WatchPartyStore");
export const CHAT_STORE = Symbol("ChatStore");
export const PASSWORD_HASHER = Symbol("PasswordHasher");
export const ATTEMPT_LIMITER = Symbol("AttemptLimiterPort");
export const LIFECYCLE_OUTBOX = Symbol("LifecycleOutboxPort");
export const MEDIA_SESSION = Symbol("MediaSessionPort");
export const ROOM_STATE_PROJECTION = Symbol("RoomStateProjectionPort");
