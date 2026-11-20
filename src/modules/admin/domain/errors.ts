/*
 * Admin errors. Each kind maps to one HTTP status at the presentation
 * boundary (presentation/error-mapper.ts); the message is what clients see.
 */

export type AdminErrorKind = "NOT_FOUND" | "BAD_REQUEST";

export abstract class AdminDomainError extends Error {
    abstract readonly kind: AdminErrorKind;
}

/** The upload session is unknown, expired, or belongs to another upload. */
export class UploadSessionNotFound extends AdminDomainError {
    readonly kind = "NOT_FOUND" as const;
}

/** Object storage or the catalog refused a step of the upload. */
export class UploadStepFailed extends AdminDomainError {
    readonly kind = "BAD_REQUEST" as const;
}

/**
 * A transcode job that can never succeed (its movie is gone). Not an HTTP
 * error: the worker turns it into BullMQ's UnrecoverableError.
 */
export class TranscodeSourceMissing extends Error {
    constructor(movieId: string) {
        super(`Movie ${movieId} not found; dropping transcode job`);
        this.name = "TranscodeSourceMissing";
    }
}

/** Message text of an unknown error, as the old services formatted it. */
const reason = (error: unknown) => (error as Error).message;

export const MESSAGES = {
    sessionExpired: "Ingestion pipeline session has expired",
    sessionMismatch: "Ingestion session is mismatch",
    initiateFailed: (error: unknown) =>
        `Initialization vector failure: ${reason(error)}`,
    chunkFailed: (partNumber: number, error: unknown) =>
        `Chunk ingestion failure on part ${partNumber}: ${reason(error)}`,
    finalizeFailed: (error: unknown) =>
        `Multipart closure operation failed: ${reason(error)}`,
} as const;
