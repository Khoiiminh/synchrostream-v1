import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import type { AdminTelemetryBroadcastPort } from "../../application/ports/collaborators.port.js";
import { ADMIN_TELEMETRY_BROADCAST } from "../../application/ports/tokens.js";
import {
    TRANSCODE_TELEMETRY_CHANNEL,
    type TranscodeTelemetryMessage,
} from "./transcode-queue.contract.js";

/**
 * API side: subscribes to the worker's telemetry channel and re-emits each
 * message on the /telemetry socket namespace. Every API instance subscribes,
 * so admins connected to any instance see the update.
 */
@Injectable()
export class TranscodeTelemetryRelay implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TranscodeTelemetryRelay.name);
    private subscriber?: Redis;

    constructor(
        private readonly configService: ConfigService,
        @Inject(ADMIN_TELEMETRY_BROADCAST)
        private readonly gateway: AdminTelemetryBroadcastPort,
    ) {}

    async onModuleInit() {
        const url = this.configService.get<string>("REDIS_URL");
        if (!url) throw new Error("REDIS_URL is not defined");

        this.subscriber = new Redis(url, { keepAlive: 30000 });
        this.subscriber.on("error", (err: Error) =>
            this.logger.warn({
                message: "Telemetry subscriber connection error",
                err,
            }),
        );
        this.subscriber.on("message", (_channel: string, raw: string) =>
            this.handleMessage(raw),
        );
        await this.subscriber.subscribe(TRANSCODE_TELEMETRY_CHANNEL);
    }

    handleMessage(raw: string): void {
        let message: TranscodeTelemetryMessage;
        try {
            message = JSON.parse(raw) as TranscodeTelemetryMessage;
        } catch {
            this.logger.warn({
                message: "Dropped malformed telemetry message",
            });
            return;
        }

        if (message.type === "status") {
            this.gateway.broadcastMovieStatusUpdate({
                movieId: message.movieId,
                status: message.status,
                hlsUrl: message.hlsUrl,
            });
        } else if (message.type === "progress") {
            this.gateway.broadcastTranscodeProgress({
                movieId: message.movieId,
                phase: message.phase,
                percent: message.percent,
            });
        }
    }

    onModuleDestroy() {
        this.subscriber?.disconnect();
    }
}
