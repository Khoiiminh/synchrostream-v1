import { Module } from "@nestjs/common";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { AdminController } from "./admin.controller.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";
import { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";

@Module({
    controllers: [AdminController],
    providers: [AdminIngestionService, AdminTranscodingService, MediaTelemetryGateway],
    exports: [AdminIngestionService, AdminTranscodingService]
})
export class AdminModule {}