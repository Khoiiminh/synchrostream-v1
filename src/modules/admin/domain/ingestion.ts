/*
 * Uploading a movie: a multipart upload to object storage, tracked by an
 * in-memory session from initiate to finalize. A session left open longer
 * than the TTL is aborted by a periodic sweep.
 */

export interface IngestionSession {
    uploadId: string;
    objectKey: string;
    createdAt: number;
}

export interface UploadedPart {
    PartNumber: number;
    ETag: string;
}

/** An upload may stay open for 30 minutes. */
export const INGESTION_SESSION_TTL_MS = 1_800_000;

/** Open sessions are checked against the TTL every 10 minutes. */
export const INGESTION_SWEEP_INTERVAL_MS = 600_000;

/** Object key of a movie's raw upload (the transcoder's input). */
export const mezzanineKeyFor = (movieId: string) =>
    `raw-mezzanines/${movieId}.mp4`;

/** Strictly older than the TTL; a session exactly at the TTL is kept. */
export function isSessionExpired(
    session: IngestionSession,
    now: number,
): boolean {
    return now - session.createdAt > INGESTION_SESSION_TTL_MS;
}

/** Storage needs the parts in ascending part-number order. Sorts in place. */
export function orderParts(parts: UploadedPart[]): UploadedPart[] {
    return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

/** The metadata JSON stored with a new movie. */
export function movieMetadataJson(details: {
    genre: string;
    description: string;
}): string {
    return JSON.stringify({
        genre: details.genre,
        description: details.description,
    });
}

export function uploadConfirmation(movieId: string): string {
    return `Mezzanine master file successfully consolidated on storage bucket. Background multi-variant HLS encoding matrix initialized for Movie ID: ${movieId}.`;
}
