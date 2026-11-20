import {
    isSessionExpired,
    type IngestionSession,
} from "../../domain/ingestion.js";
import { MESSAGES, UploadSessionNotFound } from "../../domain/errors.js";
import type {
    AdminLogger,
    MovieCatalogPort,
    ObjectStoragePort,
} from "../ports/collaborators.port.js";

/**
 * The open uploads of this process, keyed by movie id. In memory: a restart
 * loses them, so shutdown aborts them and the sweep aborts stale ones.
 */
export class UploadSessions {
    private readonly sessions = new Map<string, IngestionSession>();

    constructor(
        private readonly storage: ObjectStoragePort,
        private readonly catalog: MovieCatalogPort,
        private readonly logger: AdminLogger,
    ) {}

    get size(): number {
        return this.sessions.size;
    }

    open(movieId: string, session: IngestionSession): void {
        this.sessions.set(movieId, session);
    }

    close(movieId: string): void {
        this.sessions.delete(movieId);
    }

    /**
     * The session for this movie and upload id, or a 404-kind error.
     * `step` names the operation in the rejection log ("Chunk", "Finalize").
     */
    require(movieId: string, uploadId: string, step: string): IngestionSession {
        const session = this.sessions.get(movieId);

        if (!session) {
            this.logger.warn({
                message: `${step} rejected: ingestion session not found or expired`,
                movieId,
            });
            throw new UploadSessionNotFound(MESSAGES.sessionExpired);
        }
        if (session.uploadId !== uploadId) {
            this.logger.warn({
                message: `${step} rejected: upload id mismatch`,
                movieId,
                expectedUploadId: session.uploadId,
                uploadId,
            });
            throw new UploadSessionNotFound(MESSAGES.sessionMismatch);
        }
        return session;
    }

    /** Marks the movie FAILED after an aborted upload; never throws. */
    async markFailed(movieId: string): Promise<void> {
        try {
            await this.catalog.markFailed(movieId);
            this.logger.warn({
                message: "Marked movie as FAILED after aborted ingestion",
                movieId,
            });
        } catch (dbErr) {
            this.logger.error({
                message:
                    "Failed to mark movie as FAILED after aborted ingestion",
                movieId,
                err: dbErr,
            });
        }
    }

    /**
     * Aborts every session past the TTL. Fire and forget: the storage abort
     * and the FAILED marking run in the background; the session is closed now.
     */
    sweepExpired(now: number): void {
        this.logger.debug({
            message: "Scanning ingestion sessions for stale uploads",
        });

        for (const [movieId, session] of this.sessions.entries()) {
            if (isSessionExpired(session, now)) {
                this.logger.warn({
                    message: "Ingestion session timed out; aborting upload",
                    movieId,
                });

                this.storage
                    .abortMultiPartUpload({
                        key: session.objectKey,
                        uploadId: session.uploadId,
                    })
                    .catch((err: unknown) =>
                        this.logger.error({
                            message: "Failed to abort timed-out upload on R2",
                            movieId,
                            err,
                        }),
                    );

                void this.markFailed(movieId);

                this.sessions.delete(movieId);
            }
        }
    }

    /** On shutdown: aborts every open upload; movies still PROCESSING become FAILED. */
    async abortAll(reason: string): Promise<void> {
        for (const [movieId, session] of this.sessions.entries()) {
            try {
                this.logger.warn({
                    message: "Aborting orphaned multipart upload on R2",
                    movieId,
                    reason,
                });
                await this.storage.abortMultiPartUpload({
                    key: session.objectKey,
                    uploadId: session.uploadId,
                });

                await this.catalog.markFailedIfProcessing(movieId);
            } catch (error) {
                this.logger.error({
                    message: "Failed to clean up aborted upload assets",
                    movieId,
                    err: error,
                });
            }
        }
        this.sessions.clear();
    }
}
