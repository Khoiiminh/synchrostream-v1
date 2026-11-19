/* Room lifecycle outbox timing and retry policy. */

/** Hard bound for one event's side effects so a hung call cannot outlive its lease. */
export const EVENT_TIMEOUT_MS = 25_000;
/** Attempts before an event is parked as DEAD (the sweeper re-enqueues the aggregate). */
export const DEAD_LETTER_ATTEMPTS = 20;
/** A room that cannot be provisioned within this window is terminated. */
export const PROVISIONING_TIMEOUT_MINUTES = 10;
/** Only media sessions stuck at least this long are re-enqueued by the sweeper. */
export const STUCK_MEDIA_SESSION_MINUTES = 2;
/** COMPLETED events are kept this long for diagnostics, then pruned. */
export const COMPLETED_RETENTION_DAYS = 7;

/** Rejects with "<label> timed out after <ms> ms" if `work` takes longer. */
export async function withTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
            () =>
                reject(
                    new Error(`${label} timed out after ${timeoutMs} ms`),
                ),
            timeoutMs,
        );
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}
