/**
 * The structured logger the use cases write to. Nest's `Logger` satisfies it;
 * the application layer depends on this shape, not on Nest.
 */
export interface WatchPartyLogger {
    log(message: unknown): void;
    warn(message: unknown): void;
    error(message: unknown): void;
    debug(message: unknown): void;
}
