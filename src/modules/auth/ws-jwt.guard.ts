import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { WsException } from "@nestjs/websockets";
import type {
    AuthenticatedSocket,
    JwtPayload,
    UserProfileRow,
} from "./auth.types.js";

@Injectable()
export class WsJwtGuard implements CanActivate {
    private readonly logger = new Logger(WsJwtGuard.name);

    constructor(
        private readonly jwtService: JwtService,
        private readonly pg: PostgresProvider,
        private readonly configService: ConfigService,
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
            const payload = this.jwtService.verify<
                JwtPayload & { id?: string }
            >(token, {
                secret: this.configService.get<string>("JWT_SECRET"),
            });

            const user = await this.pg.query<UserProfileRow>(
                "SELECT id, username, email, role FROM users WHERE id = $1",
                [payload.sub || payload.id],
            );

            if (!user || user.rows.length < 1) {
                throw new WsException(
                    "User profile matching token signature not found.",
                );
            }

            // Append authenticated state context onto the active socket instance
            client.data = {
                user: {
                    id: user.rows[0].id,
                    username: user.rows[0].username,
                    email: user.rows[0].email,
                    role: user.rows[0].role,
                },
            };

            return true;
        } catch (error) {
            this.logger.warn({
                message: "WebSocket rejected: authentication failed",
                err: error,
            });
            throw new WsException("Unauthorized handshake.");
        }
    }
}
