import type { UploadedPart } from "../../domain/ingestion.js";
import type {
    MovieStatus,
    TranscodePhase,
    TranscodeTelemetryMessage,
} from "../../domain/transcode.js";

/*
 * What the admin use cases need from outside the module.
 * Bindings: infrastructure/admin.bindings.ts (and the telemetry gateway in
 * admin.module.ts).
 */

/**
 * Writes to the movie catalog, owned by the media module. Every write drops
 * the cached catalog. Adapter: media/queries/movie-catalog-writes.ts.
 */
export interface MovieCatalogPort {
    generateMovieId(): Promise<string>;
    insertProcessingMovie(
        movieId: string,
        title: string,
        metadataJson: string,
    ): Promise<void>;
    findMovieStatus(
        movieId: string,
    ): Promise<{ id: string; status: string } | undefined>;
    markProcessing(movieId: string): Promise<void>;
    markFailed(movieId: string): Promise<void>;
    /** Only PROCESSING → FAILED; finished movies are left alone. */
    markFailedIfProcessing(movieId: string): Promise<void>;
    markAvailable(movieId: string, manifestKey: string): Promise<void>;
}

/**
 * Multipart uploads to the object store.
 * Adapter: shared/infrastructure/storage/cloudflare-r2.provider.ts.
 */
export interface ObjectStoragePort {
    startMultiPartUpload(key: string): Promise<string>;
    uploadPart(part: {
        key: string;
        uploadId: string;
        partNumber: number;
        body: Buffer;
    }): Promise<string>;
    completeMultiPartUpload(upload: {
        key: string;
        uploadId: string;
        parts: UploadedPart[];
    }): Promise<void>;
    abortMultiPartUpload(upload: {
        key: string;
        uploadId: string;
    }): Promise<void>;
}

/** Hands a movie to the transcode worker. Adapter: the BullMQ producer. */
export interface TranscodeQueuePort {
    enqueueTranscode(movieId: string): Promise<void>;
}

/** Live status for admins watching the /telemetry socket namespace. */
export interface AdminTelemetryBroadcastPort {
    broadcastMovieStatusUpdate(update: {
        movieId: string;
        status: MovieStatus;
        hlsUrl?: string;
    }): void;
    broadcastTranscodeProgress(update: {
        movieId: string;
        phase: TranscodePhase;
        percent: number;
    }): void;
}

/** Worker → API telemetry. Best effort: publishing never throws. */
export interface TranscodeTelemetryPort {
    publish(message: TranscodeTelemetryMessage): Promise<void>;
}

export type TranscodeProgressListener = (
    phase: TranscodePhase,
    percent: number,
) => void;

/** Downloads, encodes and uploads one movie; returns the master manifest key. */
export interface TranscoderPort {
    run(job: {
        movieId: string;
        mezzanineKey: string;
        onProgress?: TranscodeProgressListener;
    }): Promise<string>;
}

/** Nest's Logger satisfies this; the use cases depend on the shape only. */
export interface AdminLogger {
    log(message: unknown): void;
    warn(message: unknown): void;
    error(message: unknown): void;
    debug(message: unknown): void;
}
