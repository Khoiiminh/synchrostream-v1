import {
    mezzanineKeyFor,
    movieMetadataJson,
    orderParts,
    uploadConfirmation,
    type UploadedPart,
} from "../../domain/ingestion.js";
import { MESSAGES, UploadStepFailed } from "../../domain/errors.js";
import type {
    AdminLogger,
    AdminTelemetryBroadcastPort,
    MovieCatalogPort,
    ObjectStoragePort,
    TranscodeQueuePort,
} from "../ports/collaborators.port.js";
import type { UploadSessions } from "./upload-sessions.js";

/** Starts a movie upload: a PROCESSING movie and an open multipart upload. */
export class InitiateUpload {
    constructor(
        private readonly catalog: MovieCatalogPort,
        private readonly storage: ObjectStoragePort,
        private readonly sessions: UploadSessions,
        private readonly logger: AdminLogger,
    ) {}

    async execute(details: {
        title: string;
        genre: string;
        description: string;
    }): Promise<{ movieId: string; uploadId: string; objectKey: string }> {
        const movieId = await this.catalog.generateMovieId();

        const objectKey = mezzanineKeyFor(movieId);

        try {
            this.logger.log({
                message: "Starting multipart upload on R2",
                objectKey,
            });
            const uploadId = await this.storage.startMultiPartUpload(objectKey);

            await this.catalog.insertProcessingMovie(
                movieId,
                details.title,
                movieMetadataJson(details),
            );

            this.sessions.open(movieId, {
                uploadId,
                objectKey,
                createdAt: Date.now(),
            });

            return { movieId, uploadId, objectKey };
        } catch (error) {
            this.logger.error({
                message: "Failed to initialize multipart upload",
                err: error,
            });
            throw new UploadStepFailed(MESSAGES.initiateFailed(error));
        }
    }
}

/** Stores one part of an open upload. */
export class UploadChunk {
    constructor(
        private readonly storage: ObjectStoragePort,
        private readonly sessions: UploadSessions,
        private readonly logger: AdminLogger,
    ) {}

    async execute(params: {
        movieId: string;
        uploadId: string;
        partNumber: number;
        fileBuffer: Buffer;
    }): Promise<{ etag: string }> {
        this.logger.debug({
            message: "Uploading chunk",
            movieId: params.movieId,
            uploadId: params.uploadId,
            partNumber: params.partNumber,
            bytes: params.fileBuffer.length,
        });

        const session = this.sessions.require(
            params.movieId,
            params.uploadId,
            "Chunk",
        );

        try {
            const etag = await this.storage.uploadPart({
                key: session.objectKey,
                uploadId: session.uploadId,
                partNumber: params.partNumber,
                body: params.fileBuffer,
            });

            this.logger.debug({
                message: "Chunk uploaded",
                movieId: params.movieId,
                partNumber: params.partNumber,
                etag,
            });

            return { etag };
        } catch (error) {
            this.logger.error({
                message: "Chunk upload failed",
                movieId: params.movieId,
                partNumber: params.partNumber,
                err: error,
            });
            throw new UploadStepFailed(
                MESSAGES.chunkFailed(params.partNumber, error),
            );
        }
    }
}

/**
 * Completes the multipart upload and hands the movie to the transcoder.
 * The session ends whatever happens.
 */
export class FinalizeUpload {
    constructor(
        private readonly storage: ObjectStoragePort,
        private readonly queue: TranscodeQueuePort,
        private readonly broadcast: AdminTelemetryBroadcastPort,
        private readonly sessions: UploadSessions,
        private readonly logger: AdminLogger,
    ) {}

    async execute({
        movieId,
        uploadId,
        parts,
    }: {
        movieId: string;
        uploadId: string;
        parts: UploadedPart[];
    }): Promise<{ message: string; objectKey: string; movieId: string }> {
        this.logger.log({
            message: "Finalizing multipart upload",
            movieId,
            uploadId,
            partCount: parts.length,
        });

        const session = this.sessions.require(movieId, uploadId, "Finalize");

        try {
            await this.storage.completeMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId,
                parts: orderParts(parts),
            });

            this.logger.log({
                message: "Multipart upload completed on R2",
                movieId,
                objectKey: session.objectKey,
            });
            await this.enqueueTranscodeOrFail(movieId);

            return {
                message: uploadConfirmation(movieId),
                objectKey: session.objectKey,
                movieId: movieId,
            };
        } catch (error) {
            this.logger.error({
                message: "Failed to complete multipart upload",
                movieId,
                err: error,
            });
            throw new UploadStepFailed(MESSAGES.finalizeFailed(error));
        } finally {
            this.logger.debug({
                message: "Removed ingestion session",
                movieId,
            });
            this.sessions.close(movieId);
        }
    }

    /**
     * The upload itself succeeded, so a queue outage must not turn the
     * response into an error. Instead the movie is marked FAILED and the
     * admin UI is told.
     */
    private async enqueueTranscodeOrFail(movieId: string): Promise<void> {
        try {
            await this.queue.enqueueTranscode(movieId);
        } catch (err) {
            this.logger.error({
                message: "Post-upload transcode enqueue failed",
                movieId,
                err,
            });
            await this.sessions.markFailed(movieId);
            this.broadcast.broadcastMovieStatusUpdate({
                movieId,
                status: "FAILED",
            });
        }
    }
}
