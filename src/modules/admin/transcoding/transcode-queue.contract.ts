import type { ConfigService } from "@nestjs/config";
import type { ConnectionOptions, JobsOptions } from "bullmq";

/*
 * The contract shared by the API process (producer) and the transcode worker
 * process (consumer). Both sides import only this file from each other, so the
 * queue name, payload shape and telemetry messages cannot drift apart.
 */

export const TRANSCODE_QUEUE_NAME = "media-transcode";
export const TRANSCODE_JOB_NAME = "transcode-movie";

/** Injection token for the BullMQ Queue the API enqueues into. */
export const TRANSCODE_QUEUE = Symbol("TRANSCODE_QUEUE");

/** Redis pub/sub channel the worker publishes telemetry on; the API relays it. */
export const TRANSCODE_TELEMETRY_CHANNEL = "media:transcode:telemetry";

export interface TranscodeJobData {
    movieId: string;
    /** R2 key of the consolidated raw upload, e.g. raw-mezzanines/<id>.mp4 */
    mezzanineKey: string;
}

export type MovieStatus = "PROCESSING" | "AVAILABLE" | "FAILED";
export type TranscodePhase = "DOWNLOADING" | "ENCODING" | "UPLOADING";

export type TranscodeTelemetryMessage =
    | {
          type: "status";
          movieId: string;
          status: MovieStatus;
          hlsUrl?: string;
      }
    | {
          type: "progress";
          movieId: string;
          phase: TranscodePhase;
          /** 0–100, within the phase */
          percent: number;
      };

/** Minimal queue surface the API needs; lets tests pass a fake. */
export interface TranscodeQueue {
    add(
        name: string,
        data: TranscodeJobData,
        opts?: JobsOptions,
    ): Promise<unknown>;
    close(): Promise<void>;
}

export const mezzanineKeyFor = (movieId: string) =>
    `raw-mezzanines/${movieId}.mp4`;

/**
 * Wait before the first attempt so the completed multipart object has
 * propagated on R2 (the old in-process trigger used the same 2.5 s delay).
 */
export const TRANSCODE_START_DELAY_MS = 2500;

export function transcodeJobOptions(
    movieId: string,
    maxAttempts: number,
): JobsOptions {
    return {
        // One job per movie: a duplicate enqueue while a job exists is a no-op.
        jobId: movieId,
        delay: TRANSCODE_START_DELAY_MS,
        attempts: maxAttempts,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
    };
}

export function transcodeMaxAttempts(config: ConfigService): number {
    const raw = Number(config.get<string>("TRANSCODE_MAX_ATTEMPTS"));
    return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

/**
 * BullMQ opens its own ioredis connections from these options. Workers need
 * `maxRetriesPerRequest: null` for their blocking connection; the producer
 * keeps ioredis' default so `add()` fails fast when Redis is unreachable.
 */
export function bullConnection(
    config: ConfigService,
    { forWorker }: { forWorker: boolean },
): ConnectionOptions {
    const url = config.get<string>("REDIS_URL");
    if (!url) throw new Error("REDIS_URL is not defined");
    return forWorker ? { url, maxRetriesPerRequest: null } : { url };
}
