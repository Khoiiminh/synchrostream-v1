import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { MediaSession, mapMediaSessionRow } from "./media-session.types.js";
import { MediaSessionRepository } from "./media-session.repository.js";

@Injectable()
export class MediaSessionService {
    private readonly logger = new Logger(MediaSessionService.name);

    constructor(private readonly repository: MediaSessionRepository) {}

    /**
     * Creates the control-plane representation of a media session.
     *
     * This method does NOT create the LiveKit room.
     * It only creates the authoritative MediaSession record in PostgreSQL.
     */
    async createMediaSession(roomId: string): Promise<MediaSession> {
        this.logger.debug({
            message: "Creating MediaSession",
            roomId,
        });

        /*
         * A room must exist and be active before a media session can be created.
         */
        const room = await this.repository.findRoomActivity(roomId);

        if (!room) {
            throw new NotFoundException(
                "The requested watch room does not exist.",
            );
        }

        if (!room.is_active) {
            throw new ConflictException(
                "Cannot create a media session for an inactive room.",
            );
        }

        /*
         * The database already enforces the invariant that a room may have
         * at most one active-ish MediaSession through the partial unique index.
         *
         * We still check explicitly here so the API can return a meaningful
         * application-level error instead of relying solely on PostgreSQL.
         */
        const existingSession =
            await this.repository.findAnyOpenSessionByRoomId(roomId);

        if (existingSession) {
            throw new ConflictException(
                "The room already has an active media session.",
            );
        }

        try {
            /*
             * Insert only while the room is ACTIVE, holding a share lock on the
             * room row. Owner termination takes FOR UPDATE on the same row, so a
             * session is either created before termination (and then ended by the
             * termination worker) or not created at all. A plain is_active read
             * followed by INSERT could leave a CREATED session on a TERMINATED room.
             */
            const row =
                await this.repository.insertCreatedSessionIfRoomActive(roomId);

            if (!row) {
                throw new ConflictException(
                    "Cannot create a media session for an inactive room.",
                );
            }

            const session = mapMediaSessionRow(row);

            this.logger.log({
                message: "MediaSession created successfully",
                mediaSessionId: session.id,
                roomId: session.roomId,
                status: session.status,
            });

            return session;
        } catch (error) {
            /*
             * The PostgreSQL partial unique index is the final concurrency
             * protection. Two simultaneous requests may both pass the
             * application-level existence check, but PostgreSQL still prevents
             * duplicate active sessions.
             */
            this.logger.error({
                message: "Failed to create MediaSession",
                roomId,
                err: error,
            });

            throw error;
        }
    }

    /**
     * Retrieves a MediaSession by its control-plane identity.
     */
    async getMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const row = await this.repository.findById(mediaSessionId);

        if (!row) {
            throw new NotFoundException(
                "The requested media session does not exist.",
            );
        }

        return mapMediaSessionRow(row);
    }

    async getMediaSessionByRoomId(roomId: string): Promise<MediaSession> {
        const row = await this.repository.findLatestOpenSessionByRoomId(roomId);

        if (!row) {
            throw new NotFoundException(
                "The requested watch room does not have an active media session.",
            );
        }

        return mapMediaSessionRow(row);
    }

    /**
     * Permanently closes a MediaSession.
     *
     * This should happen after the media runtime has been successfully
     * terminated by the media provider (LiveKit).
     */
    async completeMediaSession(mediaSessionId: string): Promise<MediaSession> {
        const row = await this.repository.markEnded(mediaSessionId);

        if (!row) {
            throw new ConflictException(
                "MediaSession cannot transition to ENDED from its current state.",
            );
        }

        this.logger.log({
            message: "MediaSession transitioned to ENDED",
            mediaSessionId,
        });

        return mapMediaSessionRow(row);
    }
}
