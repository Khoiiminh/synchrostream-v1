import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import {
    TRANSCODE_TELEMETRY_CHANNEL,
    type TranscodeTelemetryMessage,
} from "./transcode-queue.contract.js";

/** Worker side: publishes status and progress for the API to relay. */
@Injectable()
export class TranscodeTelemetryPublisher
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = new Logger(TranscodeTelemetryPublisher.name);
    private client?: Redis;

    constructor(private readonly configService: ConfigService) {}

    onModuleInit() {
        const url = this.configService.get<string>("REDIS_URL");
        if (!url) throw new Error("REDIS_URL is not defined");
        this.client = new Redis(url, { keepAlive: 30000 });
        this.client.on("error", (err: Error) =>
            this.logger.warn({
                message: "Telemetry publisher connection error",
                err,
            }),
        );
    }

    /** Best effort: telemetry must never fail a transcode job. */
    async publish(message: TranscodeTelemetryMessage): Promise<void> {
        try {
            await this.client?.publish(
                TRANSCODE_TELEMETRY_CHANNEL,
                JSON.stringify(message),
            );
        } catch (err) {
            this.logger.warn({
                message: "Failed to publish transcode telemetry",
                movieId: message.movieId,
                err,
            });
        }
    }

    onModuleDestroy() {
        this.client?.disconnect();
    }
}
