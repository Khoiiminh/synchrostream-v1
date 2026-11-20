import type { MediaSession } from "../../domain/media-session.js";
import { MESSAGES, MediaConflict, MediaNotFound } from "../../domain/errors.js";
import type { MediaSessionStore } from "../ports/media-session-store.port.js";
import type {
    LiveKitLogger,
    RoomAccessPort,
} from "../ports/collaborators.port.js";

/**
 * The control-plane records of media sessions: create, read and complete.
 * None of these touch the provider; LiveKit rooms are created and deleted by
 * the start and end use cases.
 */
export class MediaSessionRecords {
    constructor(
        private readonly store: MediaSessionStore,
        private readonly rooms: RoomAccessPort,
        private readonly logger: LiveKitLogger,
    ) {}

    /**
     * Creates the CREATED record for an ACTIVE room. Does not create the
     * LiveKit room.
     * @throws OpenSessionConflict when a concurrent request created one first.
     */
    async create(roomId: string): Promise<MediaSession> {
        this.logger.debug({
            message: "Creating MediaSession",
            roomId,
        });

        const room = await this.rooms.findRoomActivity(roomId);

        if (!room) {
            throw new MediaNotFound(MESSAGES.roomNotFound);
        }

        if (!room.is_active) {
            throw new MediaConflict(MESSAGES.roomInactive);
        }

        /*
         * The partial unique index already allows at most one open session per
         * room. The explicit check gives a meaningful error in the common case.
         */
        const existingSession =
            await this.store.findAnyOpenSessionByRoomId(roomId);

        if (existingSession) {
            throw new MediaConflict(MESSAGES.roomAlreadyHasSession);
        }

        try {
            /*
             * Insert only while the room is ACTIVE, holding a share lock on the
             * room row. Owner termination takes FOR UPDATE on the same row, so a
             * session is either created before termination (and then ended by the
             * termination worker) or not created at all.
             */
            const session =
                await this.store.insertCreatedSessionIfRoomActive(roomId);

            if (!session) {
                throw new MediaConflict(MESSAGES.roomInactive);
            }

            this.logger.log({
                message: "MediaSession created successfully",
                mediaSessionId: session.id,
                roomId: session.roomId,
                status: session.status,
            });

            return session;
        } catch (error) {
            // The unique index is the final guard: two requests may both pass
            // the existence check above.
            this.logger.error({
                message: "Failed to create MediaSession",
                roomId,
                err: error,
            });

            throw error;
        }
    }

    async get(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.store.findById(mediaSessionId);
        if (!session) {
            throw new MediaNotFound(MESSAGES.sessionNotFound);
        }
        return session;
    }

    async getByRoomId(roomId: string): Promise<MediaSession> {
        const session = await this.store.findLatestOpenSessionByRoomId(roomId);
        if (!session) {
            throw new MediaNotFound(MESSAGES.roomHasNoSession);
        }
        return session;
    }

    /** ENDING → ENDED, after the provider room is gone. */
    async complete(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.store.markEnded(mediaSessionId);

        if (!session) {
            throw new MediaConflict(MESSAGES.cannotComplete);
        }

        this.logger.log({
            message: "MediaSession transitioned to ENDED",
            mediaSessionId,
        });

        return session;
    }
}
