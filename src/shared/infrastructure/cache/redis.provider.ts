import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisProvider implements OnModuleInit, OnModuleDestroy {
    private client!: Redis;
    private publisher!: Redis;

    constructor(private configService: ConfigService) {

    }

    onModuleInit() {
        const connectionString = this.configService.get<string>('REDIS_URL');

        if (!connectionString) {
            throw new Error('REDIS_URL is not defined in .env.development');
        }

        const commonOptions = {
            keepAlive: 30000,
            retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            reconnectOnError: (err: Error) => {
                const targetError = 'READONLY';
                if (err.message.slice(0, targetError.length) === targetError) {
                return true; // Reconnect on target error
                }
                return 1; // Reconnect on other errors (like ECONNRESET)
            },
        };

        this.client = new Redis(connectionString, commonOptions);
        this.publisher = new Redis(connectionString, commonOptions);

        console.log('Redis Persistency & Pub/Sub clients initialized');
    }

    async setRoomState(roomCode: string, state: any): Promise<void> {
        const key = `room:${roomCode}:state`;

        // Multi() ensures atomicity for the 24h TTL
        await this.client
            .multi()
            .hset(key, state)
            .expire(key, 86400) // 24-hour self-cleaning logic
            .exec();
    }

    async publicSyncPulse(roomCode: string, payload: any): Promise<void> {
        const channel = `sync:pulse:${roomCode}`;
        await this.publisher.publish(channel, JSON.stringify(payload));
    }

    async getRoomState(roomCode: string): Promise<Record<string, string>> {
        return await this.client.hgetall(`room:${roomCode}:state`);
    }

    onModuleDestroy() {
        this.client.disconnect();
        this.publisher.disconnect();
    }
}
