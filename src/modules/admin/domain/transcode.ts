/*
 * Transcoding a movie: one job per movie, run in the worker process, retried
 * with backoff. The movie is FAILED only once the job is out of attempts or
 * cannot succeed at all.
 */

export type MovieStatus = "PROCESSING" | "AVAILABLE" | "FAILED";
export type TranscodePhase = "DOWNLOADING" | "ENCODING" | "UPLOADING";

export interface TranscodeJobData {
    movieId: string;
    /** Object key of the consolidated raw upload, e.g. raw-mezzanines/<id>.mp4 */
    mezzanineKey: string;
}

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

/**
 * Whether a failed attempt is the last one: the error can never succeed,
 * or the job has used all its attempts.
 */
export function isFinalAttempt(
    attemptsMade: number,
    maxAttempts: number,
    unrecoverable: boolean,
): boolean {
    return unrecoverable || attemptsMade >= maxAttempts;
}

/**
 * Turns ffmpeg's near per-frame progress into whole-percent steps: returns
 * the percent to report, or null when it repeats the last report.
 */
export class ProgressSteps {
    private last: { phase: TranscodePhase; percent: number } | undefined;

    next(phase: TranscodePhase, rawPercent: number): number | null {
        const percent = Math.max(0, Math.min(100, Math.floor(rawPercent)));
        if (
            this.last &&
            this.last.phase === phase &&
            this.last.percent === percent
        ) {
            return null;
        }
        this.last = { phase, percent };
        return percent;
    }
}
