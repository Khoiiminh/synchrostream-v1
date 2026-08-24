import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

@Injectable()
export class RedisBlacklistProvider implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;
    private readonly logger = new Logger(RedisBlacklistProvider.name);

    constructor(private configService: ConfigService) {}

    onModuleInit() {
        const host = this.configService.get<string>('REDIS_BLACKLIST_HOST');
        const port = this.configService.get<number>('REDIS_BLACKLIST_PORT');
        const username = this.configService.get<string>('REDIS_BLACKLIST_USERNAME');
        const password = this.configService.get<string>('REDIS_BLACKLIST_PASSWORD');

        if (!host || !port || !password) {
            this.logger.error('Missing Redis Blacklist configuration in .env.development');
            throw new Error('REDIS_BLACKLIST_CONFIG_MISSING');
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
                const targetError = 'ECONNRESET';
                if (err.message.includes(targetError)) {
                    return true;
                }
                return false;
            }
        });

        this.client.on('connect', () => {
            this.logger.log('Successfully connected to Redis Blacklist hosting')
        });

        this.client.on('error', (err) => {
            this.logger.error('Redis Blacklist Client Error', err.message);
        });

        this.logger.log('Redis Blacklist Engine initialized on dedicated hosting');
    }

    async add({ token, ttl }: {token: string, ttl: number}): Promise<void> {
        this.logger.debug(`Blacklisting token for ${ttl} seconds`);
        await this.client.set(`blacklist:${token}`, '1', 'EX', ttl);
    }

    async has(token: string): Promise<boolean> {
        const exists = await this.client.exists(`blacklist:${token}`);
        return exists === 1;
    }

    onModuleDestroy() {
        this.client.disconnect();
    }
}