import { Injectable, Logger } from "@nestjs/common";

/**
 * A helper utility designed to handle retry logic with exponential backoff 
 * for asynchronous operations (typically used with Redis or unreliable network calls).
 */
@Injectable()
export class RedisRetryHelper {
    private readonly logger = new Logger(RedisRetryHelper.name);

    /**
     * Executes an asynchronous operation with automatic retries and exponential backoff.
     * 
     * ### Mechanism & Backoff Equation
     * If an operation fails, the helper catches the error, waits for an exponentially 
     * increasing delay, and tries again up to `maxAttempts`. 
     * 
     * The waiting delay for each retry is calculated using the formula:
     * delayMs = initialDelayMs * 2^(attempt - 1)
     * 
     * Progression Example (with initialDelayMs = 200):
     * - After Attempt 1 failure: Waits 200 * (2^0) = 200 ms
     * - After Attempt 2 failure: Waits 200 * (2^1) = 400 ms
     * - After Attempt 3 failure: Waits 200 * (2^2) = 800 ms
     * 
     * ### Usage Example
     * ```ts
     * // Inside a NestJS service
     * const value = await this.redisRetryHelper.retry(
     *     async () => await this.redisClient.get('my-key'),
     *     3, // maxAttempts
     *     200 // initialDelayMs
     * );
     * ```
     * 
     * @template T The return type of the asynchronous operation.
     * @param operation An async function to execute and potentially retry.
     * @param maxAttempts The maximum number of total attempts allowed (must be an integer >= 1). Defaults to `3`.
     * @param initialDelayMs The base delay in milliseconds before the first retry (must be >= 0). Defaults to `200`.
     * @returns A promise that resolves with the result of the operation if successful.
     * @throws {Error} Throws an error if input validation fails, or if all retry attempts are exhausted (rethrows the final error).
     */
    async retry<T>(
        operation: () => Promise<T>,
        maxAttempts = 3,
        initialDelayMs = 200,
    ): Promise<T> {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new Error('maxAttempts must be a positive integer');
        }

        if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
            throw new Error('initialDelayMs must be non-negative');
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt === maxAttempts) {
                    this.logger.error(
                        `Operation failed after ${maxAttempts} attempts`,
                        error instanceof Error ? error.stack : undefined,
                    );

                    throw error;
                }

                const delayMs = initialDelayMs * 2 ** (attempt - 1);

                this.logger.warn(
                    `Attempt ${attempt}/${maxAttempts} failed. ` +
                    `Retrying in ${delayMs}ms.`,
                );

                await new Promise<void>((resolve) => {
                    setTimeout(resolve, delayMs);
                });
            }
        }

        throw new Error('Retry loop exited unexpectedly');
    }
}