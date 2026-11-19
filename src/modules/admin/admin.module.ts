import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { AdminRepository } from "./admin.repository.js";
import { AdminController } from "./admin.controller.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";
import { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";
import { MediaModule } from "../media/media.module.js";
import { TranscodeTelemetryRelay } from "./transcoding/transcode-telemetry.relay.js";
import {
    TRANSCODE_QUEUE,
    TRANSCODE_QUEUE_NAME,
    bullConnection,
    type TranscodeQueue,
} from "./transcoding/transcode-queue.contract.js";

@Module({
    imports: [MediaModule],
    controllers: [AdminController],
    providers: [
        AdminIngestionService,
        AdminTranscodingService,
        AdminRepository,
        MediaTelemetryGateway,
        TranscodeTelemetryRelay,
        {
            // Producer only: the ffmpeg work runs in the worker process.
            provide: TRANSCODE_QUEUE,
            inject: [ConfigService],
            useFactory: (config: ConfigService): TranscodeQueue =>
                new Queue(TRANSCODE_QUEUE_NAME, {
                    connection: bullConnection(config, { forWorker: false }),
                }),
        },
    ],
    exports: [AdminIngestionService, AdminTranscodingService],
})
export class AdminModule {}
