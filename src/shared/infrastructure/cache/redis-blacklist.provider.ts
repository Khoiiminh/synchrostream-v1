import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

@Injectable()
export class RedisBlacklistProvider implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;
    private readonly logger = new Logger(RedisBlacklistProvider.name);

    constructor(private configService: ConfigService) {}

    onModuleInit() {
        const host = this.configService.get<string>("REDIS_BLACKLIST_HOST");
        const port = this.configService.get<number>("REDIS_BLACKLIST_PORT");
        const username = this.configService.get<string>(
            "REDIS_BLACKLIST_USERNAME",
        );
        const password = this.configService.get<string>(
            "REDIS_BLACKLIST_PASSWORD",
        );

        if (!host || !port || !password) {
            this.logger.error({
                message: "Missing Redis blacklist configuration",
            });
            throw new Error("REDIS_BLACKLIST_CONFIG_MISSING");
        }

        this.client = new Redis({
            host,
            port,
            username,
            password,
            keepAlive: 30000,
            retryStrategy(times) {
                // Automatically reconnect without crashing the process
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            reconnectOnError(err) {
                const targetError = "ECONNRESET";
                if (err.message.includes(targetError)) {
                    return true;
                }
                return false;
            },
        });

        this.client.on("connect", () => {
            this.logger.log({ message: "Redis blacklist connected" });
        });

        this.client.on("error", (err) => {
            this.logger.error({ message: "Redis blacklist client error", err });
        });

        this.logger.debug({ message: "Redis blacklist client initialized" });
    }

    async add({ token, ttl }: { token: string; ttl: number }): Promise<void> {
        this.logger.debug({ message: "Blacklisting token", ttlSeconds: ttl });
        await this.client.set(`blacklist:${token}`, "1", "EX", ttl);
    }

    async has(token: string): Promise<boolean> {
        const exists = await this.client.exists(`blacklist:${token}`);
        return exists === 1;
    }

    onModuleDestroy() {
        this.client.disconnect();
    }
}
