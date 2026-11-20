import { Inject, Injectable, Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { TranscodeSourceMissing } from "../../domain/errors.js";
import {
    RunTranscodeJob,
    type TranscodeJobView,
} from "../../application/use-cases/run-transcode-job.js";
import type {
    MovieCatalogPort,
    TranscodeTelemetryPort,
    TranscoderPort,
} from "../../application/ports/collaborators.port.js";
import {
    MOVIE_CATALOG,
    TRANSCODE_TELEMETRY,
    TRANSCODER,
} from "../../application/ports/tokens.js";
import type { TranscodeJobData } from "./transcode-queue.contract.js";

/** The part of a BullMQ Job the processor uses; tests pass a plain object. */
export interface TranscodeJob {
    id?: string;
    data: TranscodeJobData;
    /** Failed attempts so far (BullMQ increments it after each failure). */
    attemptsMade: number;
    opts: { attempts?: number };
    updateProgress(progress: object): Promise<void>;
}

const view = (job: TranscodeJob): TranscodeJobView => ({
    data: job.data,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    updateProgress: (progress) => job.updateProgress(progress),
});

/**
 * BullMQ side of a transcode job in the worker process. A thrown error lets
 * BullMQ retry with backoff; a job whose movie is gone is thrown as
 * UnrecoverableError so it is not retried. `onFailed` fires per attempt.
 */
@Injectable()
export class TranscodeJobProcessor {
    private readonly job: RunTranscodeJob;

    constructor(
        @Inject(MOVIE_CATALOG) catalog: MovieCatalogPort,
        @Inject(TRANSCODER) transcoder: TranscoderPort,
        @Inject(TRANSCODE_TELEMETRY) telemetry: TranscodeTelemetryPort,
    ) {
        this.job = new RunTranscodeJob(
            catalog,
            transcoder,
            telemetry,
            new Logger(TranscodeJobProcessor.name),
        );
    }

    async process(job: TranscodeJob): Promise<{ hlsUrl: string }> {
        try {
            return await this.job.process(view(job));
        } catch (error) {
            if (error instanceof TranscodeSourceMissing) {
                throw new UnrecoverableError(error.message);
            }
            throw error;
        }
    }

    /** Wired to the BullMQ worker's `failed` event. */
    async onFailed(job: TranscodeJob | undefined, error: Error): Promise<void> {
        if (!job) return;
        const unrecoverable =
            error instanceof UnrecoverableError ||
            error.name === "UnrecoverableError";
        await this.job.onFailed(view(job), error, unrecoverable);
    }
}
