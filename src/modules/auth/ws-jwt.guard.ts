import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { WsException } from "@nestjs/websockets";
import { Socket } from "socket.io";

@Injectable()
export class WsJwtGuard implements CanActivate {
    private readonly logger = new Logger(WsJwtGuard.name);

    constructor(
        private readonly jwtService: JwtService,
        private readonly pg: PostgresProvider,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        try {
            const client: Socket = context.switchToWs().getClient();
            const authHeader = client.handshake.headers.authorization || client.handshake.query.token;

            if (!authHeader) {
                this.logger.error('WebSocket connection rejected: Missing authorization credentials.');
                throw new WsException('Unauthorized connection signature.');
            }

            const token = Array.isArray(authHeader) ? authHeader[0].split(' ')[1] : authHeader.split(' ')[1] || authHeader;
            const payload =  this.jwtService.verify(token);

            const [user] = await this.pg.query<any>(
                'SELECT id, username, email, role FROM users WHERE id = $1',
                [payload.sub || payload.id]
            );

            if (!user) {
                throw new WsException('User profile matching token signature not found.');
            }

            // Append authenticated state context onto the active socket instance
            client.data = {
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                }
            };

            return true;
        } catch (error) {
            this.logger.error(`WebSocket guard authorization breakdown: ${(error as Error).message}`);
            throw new WsException('Unauthorized handshake.');
        }
    }
}