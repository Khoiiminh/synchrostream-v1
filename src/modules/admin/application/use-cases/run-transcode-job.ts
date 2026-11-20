import {
    isFinalAttempt,
    ProgressSteps,
    type TranscodeJobData,
} from "../../domain/transcode.js";
import { TranscodeSourceMissing } from "../../domain/errors.js";
import type {
    AdminLogger,
    MovieCatalogPort,
    TranscodeProgressListener,
    TranscodeTelemetryPort,
    TranscoderPort,
} from "../ports/collaborators.port.js";

/** What the use case needs of a queued job; the BullMQ adapter supplies it. */
export interface TranscodeJobView {
    data: TranscodeJobData;
    /** Failed attempts so far. */
    attemptsMade: number;
    maxAttempts: number;
    updateProgress(progress: object): Promise<void>;
}

/**
 * Runs one transcode attempt in the worker. A thrown error means "retry";
 * `onFailed` marks the movie FAILED only after the final attempt.
 */
export class RunTranscodeJob {
    constructor(
        private readonly catalog: MovieCatalogPort,
        private readonly transcoder: TranscoderPort,
        private readonly telemetry: TranscodeTelemetryPort,
        private readonly logger: AdminLogger,
    ) {}

    /** @throws TranscodeSourceMissing when the movie no longer exists. */
    async process(job: TranscodeJobView): Promise<{ hlsUrl: string }> {
        const { movieId, mezzanineKey } = job.data;
        this.logger.log({
            message: "Transcode job started",
            movieId,
            attempt: job.attemptsMade + 1,
        });

        const movie = await this.catalog.findMovieStatus(movieId);
        if (!movie) {
            throw new TranscodeSourceMissing(movieId);
        }

        await this.catalog.markProcessing(movieId);
        await this.telemetry.publish({
            type: "status",
            movieId,
            status: "PROCESSING",
        });

        const hlsUrl = await this.transcoder.run({
            movieId,
            mezzanineKey,
            onProgress: this.progressReporter(job),
        });

        await this.catalog.markAvailable(movieId, hlsUrl);
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

    /** After each failed attempt; `unrecoverable` errors are final at once. */
    async onFailed(
        job: TranscodeJobView,
        error: Error,
        unrecoverable: boolean,
    ): Promise<void> {
        const { movieId } = job.data;
        const { maxAttempts } = job;

        if (!isFinalAttempt(job.attemptsMade, maxAttempts, unrecoverable)) {
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
            await this.catalog.markFailed(movieId);
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

    /** Publishes only whole-percent changes, so progress doesn't flood Redis. */
    private progressReporter(job: TranscodeJobView): TranscodeProgressListener {
        const { movieId } = job.data;
        const steps = new ProgressSteps();

        return (phase, rawPercent) => {
            const percent = steps.next(phase, rawPercent);
            if (percent === null) return;
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
