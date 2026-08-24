import { Logger } from "@nestjs/common";
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

@WebSocketGateway({
    cors: {
        origin: 'http://localhost:3000',
        credentials: true
    },
    namespace: 'telemetry',
    transports: ['websocket']
})
export class MediaTelemetryGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server!: Server;

    private readonly logger = new Logger(MediaTelemetryGateway.name);

    handleConnection(client: Socket, ...args: any[]) {
        this.logger.log(`Telemetry WebSocket Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Telemetry WebSocket Client disconnected: ${client.id}`);
    }

    /**
     *  Broadcasts real-time state change to all connected frontends
     */
    broadcastMovieStatusUpdate({ movieId, status, hlsUrl }: {movieId: string, status: 'PROCESSING' | 'AVAILABLE' | 'FAILED', hlsUrl?: string}) {
        this.logger.debug(`Broadcasting pipeline telemetry event for Movie: ${movieId} -> Status: ${status}`);
        this.server.emit('movie_status_changed', {
            movieId,
            status,
            hlsUrl
        });
    }
}