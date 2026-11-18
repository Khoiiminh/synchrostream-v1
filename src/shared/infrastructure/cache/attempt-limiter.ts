import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RedisCacheProvider } from "./redis-cache.provider.js";

/** A fixed-window limit: at most `max` counted attempts per `windowSeconds`. */
export interface AttemptRule {
    /** Key prefix; the full key is `${prefix}:${id}`. */
    readonly prefix: string;
    readonly max: number;
    readonly windowSeconds: number;
}

/** Wrong room passwords, per user per room. */
export const JOIN_PASSWORD_RULE: AttemptRule = {
    prefix: "ratelimit:join-password",
    max: 5,
    windowSeconds: 600,
};

/** Failed logins, per email (hashed). */
export const LOGIN_RULE: AttemptRule = {
    prefix: "ratelimit:login",
    max: 10,
    windowSeconds: 900,
};

/** Password-reset emails, per email (hashed); every request counts. */
export const PASSWORD_RESET_REQUEST_RULE: AttemptRule = {
    prefix: "ratelimit:password-reset-request",
    max: 3,
    windowSeconds: 900,
};

/**
 * Redis-backed attempt limiting. Fails open: if Redis is unavailable no
 * attempt is counted or blocked, so the protected flow behaves exactly as it
 * did before limiting existed.
 */
@Injectable()
export class AttemptLimiter {
    private readonly logger = new Logger(AttemptLimiter.name);

    constructor(private readonly cache: RedisCacheProvider) {}

    /** Stable, non-reversible id for an email (keeps addresses out of Redis). */
    static emailId(email: string): string {
        return createHash("sha256")
            .update(email.trim().toLowerCase())
            .digest("hex");
    }

    /** Throws 429 once `max` failures were recorded in the current window. */
    async assertAllowed(rule: AttemptRule, id: string): Promise<void> {
        const window = await this.cache.getWindow(this.key(rule, id));
        if (window && window.count >= rule.max) {
            this.reject(rule, id, window.ttlSeconds);
        }
    }

    /** Counts one failed attempt. */
    async recordFailure(rule: AttemptRule, id: string): Promise<void> {
        await this.cache.incrementWindow(
            this.key(rule, id),
            rule.windowSeconds,
        );
    }

    /** Counts this attempt and throws 429 when it goes over `max`. */
    async consume(rule: AttemptRule, id: string): Promise<void> {
        const key = this.key(rule, id);
        const count = await this.cache.incrementWindow(key, rule.windowSeconds);
        if (count !== null && count > rule.max) {
            const window = await this.cache.getWindow(key);
            this.reject(rule, id, window?.ttlSeconds ?? rule.windowSeconds);
        }
    }

    /** Clears the counter after a successful attempt. */
    async reset(rule: AttemptRule, id: string): Promise<void> {
        await this.cache.del(this.key(rule, id));
    }

    private key(rule: AttemptRule, id: string): string {
        return `${rule.prefix}:${id}`;
    }

    private reject(rule: AttemptRule, id: string, ttlSeconds: number): never {
        const retryAfterSeconds = Math.max(ttlSeconds, 1);
        const minutes = Math.ceil(retryAfterSeconds / 60);
        this.logger.warn({
            message: "Attempt limit reached",
            rule: rule.prefix,
            id,
            retryAfterSeconds,
        });
        throw new HttpException(
            {
                message: `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
                error: { code: "TOO_MANY_ATTEMPTS", retryAfterSeconds },
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}
