import type { MediaSession } from "../../domain/media-session.js";

/** An open database transaction. Opaque here; only the store adapter can use it. */
export type Tx = object;

/**
 * The `media_sessions` rows and the outbox events that commit with their
 * transitions. Adapter: infrastructure/persistence/media-session.repository.ts.
 *
 * The guarded transitions return undefined when the row was not in the
 * expected status (another operation got there first).
 */
export interface MediaSessionStore {
    findById(mediaSessionId: string): Promise<MediaSession | undefined>;
    /** Newest CREATED/STARTING/ACTIVE/ENDING session of the room. */
    findLatestOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSession | undefined>;
    /** Any CREATED/STARTING/ACTIVE/ENDING session of the room. */
    findAnyOpenSessionByRoomId(
        roomId: string,
    ): Promise<MediaSession | undefined>;

    /**
     * Inserts a CREATED session only while the room is ACTIVE, holding a share
     * lock on the room row. Undefined when the room is not ACTIVE.
     * @throws OpenSessionConflict when the room already has an open session.
     */
    insertCreatedSessionIfRoomActive(
        roomId: string,
    ): Promise<MediaSession | undefined>;
    /** ENDING → ENDED. */
    markEnded(mediaSessionId: string): Promise<MediaSession | undefined>;

    withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
    /** Locks the room row FOR UPDATE if it is ACTIVE; whether it was. */
    lockActiveRoom(tx: Tx, roomId: string): Promise<boolean>;
    /** CREATED → STARTING. */
    markSessionStarting(
        tx: Tx,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession | undefined>;
    /** STARTING → ACTIVE, setting started_at once. */
    markSessionActive(
        tx: Tx,
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession | undefined>;
    /** CREATED/STARTING/ACTIVE → ENDING. */
    markSessionEnding(
        tx: Tx,
        mediaSessionId: string,
    ): Promise<MediaSession | undefined>;
    /** LIVEKIT_SESSION_RECONCILE, due just after the startup window. */
    enqueueDelayedSessionReconcile(
        tx: Tx,
        mediaSessionId: string,
    ): Promise<void>;
    /** LIVEKIT_SESSION_RECONCILE, due now. */
    enqueueSessionReconcile(tx: Tx, mediaSessionId: string): Promise<void>;
}

/** The room already has an open session (idx_active_media_session_room). */
export class OpenSessionConflict extends Error {
    constructor(readonly cause: unknown) {
        // Keep the driver's message: it is what an unrecovered race reports.
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "OpenSessionConflict";
    }
}
