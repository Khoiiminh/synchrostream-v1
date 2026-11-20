import { Logger } from "@nestjs/common";
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    WebSocketGateway,
    WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

@WebSocketGateway({
    cors: {
        origin: "http://localhost:3000",
        credentials: true,
    },
    namespace: "telemetry",
    transports: ["websocket"],
})
export class MediaTelemetryGateway
    implements OnGatewayConnection, OnGatewayDisconnect
{
    @WebSocketServer()
    server!: Server;

    private readonly logger = new Logger(MediaTelemetryGateway.name);

    handleConnection(client: Socket) {
        this.logger.log({
            message: "Telemetry client connected",
            socketId: client.id,
        });
    }

    handleDisconnect(client: Socket) {
        this.logger.log({
            message: "Telemetry client disconnected",
            socketId: client.id,
        });
    }

    /**
     *  Broadcasts real-time state change to all connected frontends
     */
    broadcastMovieStatusUpdate({
        movieId,
        status,
        hlsUrl,
    }: {
        movieId: string;
        status: "PROCESSING" | "AVAILABLE" | "FAILED";
        hlsUrl?: string;
    }) {
        this.logger.debug({
            message: "Broadcasting pipeline telemetry",
            movieId,
            status,
        });
        this.server.emit("movie_status_changed", {
            movieId,
            status,
            hlsUrl,
        });
    }

    /** Additive event: per-phase percentage while the worker transcodes. */
    broadcastTranscodeProgress({
        movieId,
        phase,
        percent,
    }: {
        movieId: string;
        phase: "DOWNLOADING" | "ENCODING" | "UPLOADING";
        percent: number;
    }) {
        this.server.emit("movie_transcode_progress", {
            movieId,
            phase,
            percent,
        });
    }
}
