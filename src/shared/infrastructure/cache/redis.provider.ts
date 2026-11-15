import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

@Injectable()
export class RedisProvider implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RedisProvider.name);
    private client!: Redis;
    private publisher!: Redis;

    constructor(private readonly configService: ConfigService) {

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

        this.logger.log({ message: 'Redis clients initialized' });
    }

    /**
     * Applies an identity- and version-checked lifecycle projection. The tombstone
     * prevents delayed work for a terminated room from reviving its Redis key.
     */
    async reconcileRoomState(
        roomCode: string,
        state: Record<string, string | number>,
    ): Promise<boolean> {
        const key = `room:${roomCode}:state`;
        const roomId = String(state.roomId);
        const version = String(state.lifecycleVersion);
        const lifecycleStatus = String(state.lifecycleStatus);
        const fields = Object.entries(state).flatMap(([field, value]) => [field, String(value)]);

        const script = `
            local existingId = redis.call('HGET', KEYS[1], 'roomId')
            local existingStatus = redis.call('HGET', KEYS[1], 'lifecycleStatus')
            local existingVersion = tonumber(redis.call('HGET', KEYS[1], 'lifecycleVersion') or '-1')
            local incomingVersion = tonumber(ARGV[2])
            local incomingStatus = ARGV[3]

            if existingId and existingId == ARGV[1] then
                if existingVersion > incomingVersion then return 0 end
                if existingStatus == 'TERMINATED' and incomingStatus ~= 'TERMINATED' then return 0 end
            elseif existingId then
                if existingStatus ~= 'TERMINATED' then return 0 end
                redis.call('DEL', KEYS[1])
            end

            redis.call('HSET', KEYS[1], unpack(ARGV, 4))
            redis.call('EXPIRE', KEYS[1], 86400)
            return 1
        `;

        const applied = await this.client.eval(
            script,
            1,
            key,
            roomId,
            version,
            lifecycleStatus,
            ...fields,
        );
        return applied === 1;
    }

    async updateRoomState(
        roomCode: string,
        state: Record<string, string | number>,
        expectedRoomId: string,
    ): Promise<boolean> {
        const key = `room:${roomCode}:state`;

        const normalizedState: Record<string, string> = {};

        for (const [field, value] of Object.entries(state)) {
            normalizedState[field] = String(value);
        }

        const fields = Object.entries(normalizedState).flatMap(([field, value]) => [field, value]);
        const script = `
            if redis.call('HGET', KEYS[1], 'roomId') ~= ARGV[1] then return 0 end
            if redis.call('HGET', KEYS[1], 'lifecycleStatus') ~= 'ACTIVE' then return 0 end
            redis.call('HSET', KEYS[1], unpack(ARGV, 2))
            redis.call('EXPIRE', KEYS[1], 86400)
            return 1
        `;
        const applied = await this.client.eval(script, 1, key, expectedRoomId, ...fields);
        return applied === 1;
    }

    /**
     * Replaces a room-code key that is held by `staleRoomId`. The caller must
     * first prove from PostgreSQL that `staleRoomId` no longer owns the code
     * (missing or TERMINATED room). Typical case: a key written before schema v7
     * that has no lifecycleStatus, or a tombstone that was never written.
     */
    async replaceStaleRoomState(
        roomCode: string,
        staleRoomId: string,
        state: Record<string, string | number>,
    ): Promise<boolean> {
        const key = `room:${roomCode}:state`;
        const fields = Object.entries(state).flatMap(([field, value]) => [field, String(value)]);
        const script = `
            if redis.call('HGET', KEYS[1], 'roomId') ~= ARGV[1] then return 0 end
            redis.call('DEL', KEYS[1])
            redis.call('HSET', KEYS[1], unpack(ARGV, 2))
            redis.call('EXPIRE', KEYS[1], 86400)
            return 1
        `;
        return (await this.client.eval(script, 1, key, staleRoomId, ...fields)) === 1;
    }

    private presenceKey(roomId: string, userId: string): string {
        return `presence:room:${roomId}:user:${userId}`;
    }

    /** Marks room members as present for `ttlSeconds`. */
    async refreshPresence(
        members: Array<{ roomId: string; userId: string }>,
        ttlSeconds: number,
    ): Promise<void> {
        if (members.length === 0) return;
        const pipeline = this.client.pipeline();
        for (const member of members) {
            pipeline.set(this.presenceKey(member.roomId, member.userId), '1', 'EX', ttlSeconds);
        }
        const results = await pipeline.exec();
        const failed = results?.find(([error]) => error);
        if (failed?.[0]) throw failed[0];
    }

    /** Returns, in order, whether each member currently has a presence key. */
    async getPresence(members: Array<{ roomId: string; userId: string }>): Promise<boolean[]> {
        if (members.length === 0) return [];
        const values = await this.client.mget(
            ...members.map((member) => this.presenceKey(member.roomId, member.userId)),
        );
        return values.map((value) => value !== null);
    }

    async clearPresence(roomId: string, userId: string): Promise<void> {
        await this.client.del(this.presenceKey(roomId, userId));
    }

    async delRoomState(roomCode: string, expectedRoomId: string): Promise<boolean> {
        const key = `room:${roomCode}:state`;
        const script = `
            if redis.call('HGET', KEYS[1], 'roomId') ~= ARGV[1] then return 0 end
            return redis.call('DEL', KEYS[1])
        `;
        return (await this.client.eval(script, 1, key, expectedRoomId)) === 1;
    }

    async publicSyncPulse(roomCode: string, payload: unknown): Promise<void> {
        const channel = `sync:pulse:${roomCode}`;

        await this.publisher.publish(
            channel, 
            JSON.stringify(payload)
        );
    }

    async getRoomState(roomCode: string): Promise<Record<string, string>> {
        return await this.client.hgetall(`room:${roomCode}:state`);
    }

    onModuleDestroy() {
        this.client.disconnect();
        this.publisher.disconnect();
    }
}
