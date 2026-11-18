import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PostgresProvider } from "./database/postgres.provider.js";
import { RedisProvider } from "./cache/redis.provider.js";
import { CloudflareR2Provider } from "./storage/cloudflare-r2.provider.js";
import { RedisBlacklistProvider } from "./cache/redis-blacklist.provider.js";
import { RedisCacheProvider } from "./cache/redis-cache.provider.js";
import { AttemptLimiter } from "./cache/attempt-limiter.js";
import { SfuControlClient } from "./sfu/sfu-control.client.js";
import { SfuSignalingTokenService } from "./sfu/sfu-signaling-token.service.js";
import { JwtModule } from "@nestjs/jwt";

@Global() // Makes these available everywhere without repeat imports
@Module({
    imports: [ConfigModule, JwtModule],
    providers: [
        PostgresProvider,
        RedisProvider,
        CloudflareR2Provider,
        RedisBlacklistProvider,
        RedisCacheProvider,
        AttemptLimiter,
        SfuControlClient,
        SfuSignalingTokenService,
    ],
    exports: [
        PostgresProvider,
        RedisProvider,
        CloudflareR2Provider,
        RedisBlacklistProvider,
        RedisCacheProvider,
        AttemptLimiter,
        SfuControlClient,
        SfuSignalingTokenService,
    ],
})
export class InfrastructureModule {}
