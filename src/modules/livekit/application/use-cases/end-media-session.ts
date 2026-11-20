import {
    canBeginEnding,
    mayHaveProviderRoom,
    type MediaSession,
} from "../../domain/media-session.js";
import { MESSAGES, MediaConflict, MediaNotFound } from "../../domain/errors.js";
import type { MediaSessionStore } from "../ports/media-session-store.port.js";
import type {
    LiveKitLogger,
    MediaProviderPort,
} from "../ports/collaborators.port.js";
import type { MediaSessionRecords } from "./session-records.js";

/**
 * Ends media sessions idempotently: ENDING (with an immediate reconcile
 * event), provider room deleted, then ENDED. Safe to repeat after any crash.
 */
export class EndMediaSession {
    constructor(
        private readonly records: MediaSessionRecords,
        private readonly store: MediaSessionStore,
        private readonly provider: MediaProviderPort,
        private readonly logger: LiveKitLogger,
    ) {}

    /**
     * Looks up and ends the room's open session, if any. Room shutdown uses
     * this after the room is made inactive.
     */
    async forRoom(roomId: string): Promise<void> {
        let session: MediaSession;

        try {
            session = await this.records.getByRoomId(roomId);
        } catch (error) {
            if (error instanceof MediaNotFound) {
                return;
            }
            throw error;
        }

        await this.byId(session.id);
    }

    /**
     * Ends one exact media-session generation. Retries never look up a newer
     * session by room id, so an old cleanup cannot terminate a replacement.
     */
    async byId(mediaSessionId: string): Promise<void> {
        let session = await this.records.get(mediaSessionId);

        if (session.status === "ENDED") {
            return;
        }

        let shouldDeleteProviderRoom = mayHaveProviderRoom(session.status);

        if (session.status !== "ENDING") {
            try {
                session = await this.markEnding(mediaSessionId);
            } catch (transitionError) {
                // Another lifecycle operation may have changed this session
                // after our read. Re-read and retry the guarded transition.
                const latestSession = await this.records.get(mediaSessionId);

                if (latestSession.status === "ENDED") {
                    return;
                }

                if (latestSession.status === "ENDING") {
                    session = latestSession;
                    shouldDeleteProviderRoom = true;
                } else if (canBeginEnding(latestSession.status)) {
                    shouldDeleteProviderRoom =
                        latestSession.status !== "CREATED";
                    try {
                        session = await this.markEnding(mediaSessionId);
                    } catch (retryTransitionError) {
                        const finalSession =
                            await this.records.get(mediaSessionId);
                        if (finalSession.status === "ENDED") {
                            return;
                        }
                        if (finalSession.status !== "ENDING") {
                            throw retryTransitionError;
                        }
                        session = finalSession;
                        shouldDeleteProviderRoom = true;
                    }
                } else {
                    throw transitionError;
                }
            }
        }

        if (session.status === "ENDED") {
            return;
        }

        if (session.status !== "ENDING") {
            throw new MediaConflict(MESSAGES.cannotTerminate(session.status));
        }

        if (shouldDeleteProviderRoom) {
            try {
                await this.provider.deleteRoomIfPresent(session.id);
            } catch (error) {
                this.logger.warn({
                    message:
                        "LiveKit room deletion during cleanup failed; session remains ENDING for retry",
                    mediaSessionId: session.id,
                    err: error,
                });
                throw error;
            }
        }

        try {
            await this.records.complete(session.id);
        } catch (completionError) {
            const latestSession = await this.records.get(session.id);
            if (latestSession.status !== "ENDED") {
                throw completionError;
            }
        }
    }

    private async markEnding(mediaSessionId: string): Promise<MediaSession> {
        return this.store.withTransaction(async (tx) => {
            const updated = await this.store.markSessionEnding(
                tx,
                mediaSessionId,
            );
            if (!updated) {
                throw new MediaConflict(MESSAGES.changedBeforeTermination);
            }
            await this.store.enqueueSessionReconcile(tx, mediaSessionId);
            return updated;
        });
    }
}
