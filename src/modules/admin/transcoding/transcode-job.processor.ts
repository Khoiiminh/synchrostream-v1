import { Injectable, Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { AdminRepository } from "../admin.repository.js";
import { TranscodePipeline } from "./transcode-pipeline.js";
import { TranscodeTelemetryPublisher } from "./transcode-telemetry.publisher.js";
import type {
    TranscodeJobData,
    TranscodePhase,
} from "./transcode-queue.contract.js";

/** The part of a BullMQ Job the processor uses; tests pass a plain object. */
export interface TranscodeJob {
    id?: string;
    data: TranscodeJobData;
    /** Failed attempts so far (BullMQ increments it after each failure). */
    attemptsMade: number;
    opts: { attempts?: number };
    updateProgress(progress: object): Promise<void>;
}

/**
 * Handles one transcode job in the worker process. A thrown error lets BullMQ
 * retry with backoff; `onFailed` marks the movie FAILED only once the job is
 * out of attempts (or the error is unrecoverable).
 */
@Injectable()
export class TranscodeJobProcessor {
    private readonly logger = new Logger(TranscodeJobProcessor.name);

    constructor(
        private readonly adminRepository: AdminRepository,
        private readonly pipeline: TranscodePipeline,
        private readonly telemetry: TranscodeTelemetryPublisher,
    ) {}

    async process(job: TranscodeJob): Promise<{ hlsUrl: string }> {
        const { movieId, mezzanineKey } = job.data;
        this.logger.log({
            message: "Transcode job started",
            movieId,
            attempt: job.attemptsMade + 1,
        });

        const movie = await this.adminRepository.findMovieStatus(movieId);
        if (!movie) {
            throw new UnrecoverableError(
                `Movie ${movieId} not found; dropping transcode job`,
            );
        }

        await this.adminRepository.markProcessing(movieId);
        await this.telemetry.publish({
            type: "status",
            movieId,
            status: "PROCESSING",
        });

        const hlsUrl = await this.pipeline.run({
            movieId,
            mezzanineKey,
            onProgress: this.progressReporter(job),
        });

        await this.adminRepository.markAvailable(movieId, hlsUrl);
        this.logger.log({
            message: "Transcode completed; movie AVAILABLE",
            movieId,
        });
        await this.telemetry.publish({
            type: "status",
            movieId,
            status: "AVAILABLE",
            hlsUrl,
        });

        return { hlsUrl };
    }

    /** Wired to the BullMQ worker's `failed` event, which fires per attempt. */
    async onFailed(job: TranscodeJob | undefined, error: Error): Promise<void> {
        if (!job) return;
        const { movieId } = job.data;
        const maxAttempts = job.opts.attempts ?? 1;
        const isFinal =
            error instanceof UnrecoverableError ||
            error.name === "UnrecoverableError" ||
            job.attemptsMade >= maxAttempts;

        if (!isFinal) {
            this.logger.warn({
                message: "Transcode attempt failed; will retry",
                movieId,
                attemptsMade: job.attemptsMade,
                maxAttempts,
                err: error,
            });
            return;
        }

        this.logger.error({
            message: "Transcode failed permanently",
            movieId,
            attemptsMade: job.attemptsMade,
            err: error,
        });
        try {
            await this.adminRepository.markFailed(movieId);
        } catch (dbError) {
            this.logger.error({
                message: "Failed to mark movie as FAILED after transcode error",
                movieId,
                err: dbError,
            });
        }
        await this.telemetry.publish({
            type: "status",
            movieId,
            status: "FAILED",
        });
    }

    /** Emits only when the whole percentage changes, so ffmpeg's ~per-frame
     * progress events don't flood Redis. */
    private progressReporter(job: TranscodeJob) {
        const { movieId } = job.data;
        let last: { phase: TranscodePhase; percent: number } | undefined;

        return (phase: TranscodePhase, rawPercent: number) => {
            const percent = Math.max(0, Math.min(100, Math.floor(rawPercent)));
            if (last && last.phase === phase && last.percent === percent) {
                return;
            }
            last = { phase, percent };
            void this.telemetry.publish({
                type: "progress",
                movieId,
                phase,
                percent,
            });
            job.updateProgress({ phase, percent }).catch((err: unknown) =>
                this.logger.debug({
                    message: "Failed to record job progress",
                    movieId,
                    err,
                }),
            );
        };
    }
}
