import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PostgresProvider } from "./database/postgres.provider.js";
import { RedisProvider } from "./cache/redis.provider.js";
import { CloudflareR2Provider } from "./storage/cloudflare-r2.provider.js";
import { RedisBlacklistProvider } from "./cache/redis-blacklist.provider.js";
import { RedisCacheProvider } from "./cache/redis-cache.provider.js";
import { AttemptLimiter } from "./cache/attempt-limiter.js";

@Global() // Makes these available everywhere without repeat imports
@Module({
    imports: [ConfigModule],
    providers: [
        PostgresProvider,
        RedisProvider,
        CloudflareR2Provider,
        RedisBlacklistProvider,
        RedisCacheProvider,
        AttemptLimiter,
    ],
    exports: [
        PostgresProvider,
        RedisProvider,
        CloudflareR2Provider,
        RedisBlacklistProvider,
        RedisCacheProvider,
        AttemptLimiter,
    ],
})
export class InfrastructureModule {}
