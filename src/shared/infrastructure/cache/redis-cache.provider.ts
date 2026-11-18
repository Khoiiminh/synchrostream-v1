import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

/**
 * Best-effort Redis access for caches and counters (see
 * docs/Redis_Cache_and_Rate_Limit_Keys.md).
 *
 * Uses its own fail-fast connection: no offline queue, one retry, a short
 * command timeout. When Redis is slow or down every method resolves to its
 * "cache miss" value (null / no-op) instead of throwing, so callers fall back
 * to PostgreSQL and behave exactly as they do with a cold cache.
 *
 * Do not use it for state that must be correct (room projection, presence):
 * that stays on RedisProvider, whose queued connection and retry helper
 * prefer waiting over failing.
 */
@Injectable()
export class RedisCacheProvider implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisCacheProvider.name);
    private client!: Redis;
    private reportedDown = false;

    constructor(private readonly configService: ConfigService) {}

    onModuleInit() {
        const connectionString = this.configService.get<string>("REDIS_URL");

        if (!connectionString) {
            throw new Error("REDIS_URL is not defined in .env.development");
        }

        this.client = new Redis(connectionString, {
            keepAlive: 30000,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            commandTimeout: 500,
            retryStrategy: (times: number) => Math.min(times * 50, 2000),
        });

        // Log one warning per outage instead of one per reconnect attempt.
        this.client.on("error", (err: Error) => {
            if (this.reportedDown) return;
            this.reportedDown = true;
            this.logger.warn({
                message:
                    "Redis cache unavailable; serving from PostgreSQL until it recovers",
                err,
            });
        });
        this.client.on("ready", () => {
            if (this.reportedDown) {
                this.logger.log({ message: "Redis cache connection restored" });
            }
            this.reportedDown = false;
        });
    }

    onModuleDestroy() {
        this.client.disconnect();
    }

    /** Parsed JSON value, or null on a miss, a parse error or a Redis failure. */
    async getJson<T>(key: string): Promise<T | null> {
        try {
            const raw = await this.client.get(key);
            return raw === null ? null : (JSON.parse(raw) as T);
        } catch (error) {
            this.logFailure("get", key, error);
            return null;
        }
    }

    async setJson(
        key: string,
        value: unknown,
        ttlSeconds: number,
    ): Promise<void> {
        try {
            await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
        } catch (error) {
            this.logFailure("set", key, error);
        }
    }

    /**
     * Deletes keys. A failed delete leaves the old value until its TTL runs
     * out, which is why every cached key here has a short TTL.
     */
    async del(...keys: string[]): Promise<void> {
        if (keys.length === 0) return;
        try {
            await this.client.del(...keys);
        } catch (error) {
            this.logFailure("del", keys.join(","), error);
        }
    }

    /**
     * Increments a fixed-window counter. The window starts on the first
     * increment and is not extended by later ones. Returns the new count, or
     * null when Redis is unavailable.
     */
    async incrementWindow(
        key: string,
        windowSeconds: number,
    ): Promise<number | null> {
        const script = `
            local count = redis.call('INCR', KEYS[1])
            if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            return count
        `;
        try {
            return Number(
                await this.client.eval(script, 1, key, windowSeconds),
            );
        } catch (error) {
            this.logFailure("incr", key, error);
            return null;
        }
    }

    /** Current counter value and remaining window, or null on a Redis failure. */
    async getWindow(
        key: string,
    ): Promise<{ count: number; ttlSeconds: number } | null> {
        try {
            const [[countError, count], [ttlError, ttl]] = (await this.client
                .multi()
                .get(key)
                .ttl(key)
                .exec()) as [
                [Error | null, string | null],
                [Error | null, number],
            ];
            if (countError) throw countError;
            if (ttlError) throw ttlError;
            return { count: Number(count ?? 0), ttlSeconds: Math.max(ttl, 0) };
        } catch (error) {
            this.logFailure("get-window", key, error);
            return null;
        }
    }

    private logFailure(operation: string, key: string, error: unknown) {
        // While the connection is known to be down the "error" handler has
        // already reported it; don't log every request.
        if (this.reportedDown) return;
        this.logger.warn({
            message: "Redis cache operation failed; continuing without cache",
            operation,
            key,
            err: error,
        });
    }
}
