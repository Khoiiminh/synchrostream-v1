import type { MediaSession } from "../../domain/media-session.js";
import { MESSAGES, MediaConflict, MediaNotFound } from "../../domain/errors.js";
import type { MediaSessionStore } from "../ports/media-session-store.port.js";
import type {
    LiveKitLogger,
    MediaProviderPort,
    RoomAccessPort,
} from "../ports/collaborators.port.js";
import type { MediaSessionRecords } from "./session-records.js";
import type { EndMediaSession } from "./end-media-session.js";

/**
 * CREATED → STARTING → provider room created → ACTIVE. Each transition
 * re-locks the room so a session never activates once the room has begun
 * termination.
 */
export class StartMediaSession {
    constructor(
        private readonly records: MediaSessionRecords,
        private readonly store: MediaSessionStore,
        private readonly rooms: RoomAccessPort,
        private readonly provider: MediaProviderPort,
        private readonly end: EndMediaSession,
        private readonly logger: LiveKitLogger,
    ) {}

    async execute(mediaSessionId: string): Promise<MediaSession> {
        const session = await this.records.get(mediaSessionId);

        if (session.status !== "CREATED") {
            throw new MediaConflict(MESSAGES.cannotStart(session.status));
        }

        const room = await this.rooms.findActiveRoom(session.roomId);

        if (!room) {
            throw new MediaNotFound(MESSAGES.startRoomMissing);
        }

        const startingSession = await this.markStarting(
            mediaSessionId,
            room.id,
        );

        try {
            await this.provider.createRoom(
                startingSession.id,
                room.max_participants,
            );

            return await this.markActive(
                mediaSessionId,
                startingSession.roomId,
            );
        } catch (error) {
            // The room may have begun termination while provider creation was
            // in flight. Cleanup addresses this exact generation, never a
            // replacement.
            try {
                await this.end.byId(mediaSessionId);
            } catch (cleanupError) {
                this.logger.warn({
                    message:
                        "Failed to clean up LiveKit room after startup did not activate",
                    mediaSessionId,
                    err: cleanupError,
                });
            }
            // The termination worker may have deleted the provider room before
            // an in-flight createRoom call completed. Delete once more after
            // creation has settled, even if the session is already ENDED.
            try {
                await this.provider.deleteRoomIfPresent(mediaSessionId);
            } catch (providerCleanupError) {
                this.logger.warn({
                    message:
                        "LiveKit provider room may require outbox retry after startup failure",
                    mediaSessionId,
                    err: providerCleanupError,
                });
            }
            throw error;
        }
    }

    private async markStarting(
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession> {
        return this.store.withTransaction(async (tx) => {
            const roomLocked = await this.store.lockActiveRoom(tx, roomId);
            if (!roomLocked) {
                throw new MediaConflict(MESSAGES.startRoomNotActive);
            }
            const updated = await this.store.markSessionStarting(
                tx,
                mediaSessionId,
                roomId,
            );
            if (!updated) {
                throw new MediaConflict(MESSAGES.changedBeforeStartup);
            }
            // Recovery for a crashed startup is only needed after the startup
            // window; claiming it earlier just fails and burns retry attempts.
            await this.store.enqueueDelayedSessionReconcile(tx, mediaSessionId);
            return updated;
        });
    }

    private async markActive(
        mediaSessionId: string,
        roomId: string,
    ): Promise<MediaSession> {
        return this.store.withTransaction(async (tx) => {
            const roomLocked = await this.store.lockActiveRoom(tx, roomId);
            if (!roomLocked) {
                throw new MediaConflict(MESSAGES.terminatingBeforeActivation);
            }
            const updated = await this.store.markSessionActive(
                tx,
                mediaSessionId,
                roomId,
            );
            if (!updated) {
                throw new MediaConflict(MESSAGES.cannotActivate);
            }
            return updated;
        });
    }
}
