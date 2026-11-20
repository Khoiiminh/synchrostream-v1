import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { WsException } from "@nestjs/websockets";
import { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";
import { RedisCacheProvider } from "@/shared/infrastructure/cache/redis-cache.provider.js";
import { AuthRepository } from "../auth.repository.js";
import type {
    AuthenticatedSocket,
    JwtPayload,
} from "@/shared/auth/auth-context.types.js";
import type { UserProfileRow } from "../auth.types.js";

/**
 * Profile rows never change after registration (no username, email or role
 * update path exists), so a 10-minute cache only bounds memory, not staleness.
 * If such an update path is added, it must delete `user:{id}:profile`.
 */
const PROFILE_TTL_SECONDS = 600;
/**
 * How long a socket reuses its last successful check for the same token
 * before the blacklist and profile are read again. This bounds how long a
 * logged-out token keeps working on an already-open socket.
 */
const SOCKET_REVALIDATE_MS = 30_000;
/** A blacklist read slower than this does not stall a playback pulse. */
const BLACKLIST_TIMEOUT_MS = 1_000;

type SocketAuthMemo = {
    token: string;
    user: NonNullable<AuthenticatedSocket["data"]["user"]>;
    checkedAt: number;
};

export function userProfileCacheKey(userId: string): string {
    return `user:${userId}:profile`;
}

@Injectable()
export class WsJwtGuard implements CanActivate {
    private readonly logger = new Logger(WsJwtGuard.name);
    /** Last successful check per socket; entries go away with the socket. */
    private readonly socketMemo = new WeakMap<object, SocketAuthMemo>();

    constructor(
        private readonly jwtService: JwtService,
        private readonly authRepository: AuthRepository,
        private readonly configService: ConfigService,
        private readonly blacklist: RedisBlacklistProvider,
        private readonly cache: RedisCacheProvider,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        try {
            const client = context
                .switchToWs()
                .getClient<AuthenticatedSocket>();
            const authHeader =
                client.handshake.headers.authorization ||
                client.handshake.query.token;

            if (!authHeader) {
                this.logger.warn({
                    message: "WebSocket rejected: missing credentials",
                });
                throw new WsException("Unauthorized connection signature.");
            }

            const token = Array.isArray(authHeader)
                ? authHeader[0].split(" ")[1]
                : authHeader.split(" ")[1] || authHeader;

            // Signature and expiry are checked on every message (CPU only).
            const payload = this.jwtService.verify<
                JwtPayload & { id?: string }
            >(token, {
                secret: this.configService.get<string>("JWT_SECRET"),
            });

            const memo = this.socketMemo.get(client);
            const now = Date.now();

            if (
                memo &&
                memo.token === token &&
                now - memo.checkedAt < SOCKET_REVALIDATE_MS
            ) {
                client.data = { user: memo.user };
                return true;
            }

            const userId = payload.sub || payload.id || "";

            if (await this.isRevoked(token, memo?.token === token)) {
                this.socketMemo.delete(client);
                throw new WsException("This session has been revoked");
            }

            const user = await this.loadProfile(userId);

            if (!user) {
                throw new WsException(
                    "User profile matching token signature not found.",
                );
            }

            const socketUser = {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
            };

            this.socketMemo.set(client, {
                token,
                user: socketUser,
                checkedAt: now,
            });

            // Append authenticated state context onto the active socket instance
            client.data = { user: socketUser };

            return true;
        } catch (error) {
            this.logger.warn({
                message: "WebSocket rejected: authentication failed",
                err: error,
            });
            throw new WsException("Unauthorized handshake.");
        }
    }

    /**
     * Blacklist check. If the blacklist store cannot answer, a socket that
     * already passed with this token keeps working (so a Redis blip does not
     * break playback); a token never seen on this socket is rejected, the same
     * fail-closed outcome the HTTP JwtStrategy has.
     */
    private async isRevoked(
        token: string,
        previouslyAccepted: boolean,
    ): Promise<boolean> {
        try {
            return await withTimeout(
                this.blacklist.has(token),
                BLACKLIST_TIMEOUT_MS,
            );
        } catch (error) {
            if (previouslyAccepted) {
                this.logger.warn({
                    message:
                        "Token blacklist unavailable; keeping the socket's earlier check",
                    err: error,
                });
                return false;
            }
            throw error;
        }
    }

    /** Profile from Redis, falling back to PostgreSQL (and refilling Redis). */
    private async loadProfile(
        userId: string,
    ): Promise<UserProfileRow | undefined> {
        if (!userId) return undefined;

        const key = userProfileCacheKey(userId);
        const cached = await this.cache.getJson<UserProfileRow>(key);
        if (cached) return cached;

        const user = await this.authRepository.findProfileById(userId);
        if (user) {
            await this.cache.setJson(key, user, PROFILE_TTL_SECONDS);
        }
        return user;
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Timed out after ${ms} ms`)),
            ms,
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
