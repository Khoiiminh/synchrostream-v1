import { Module } from "@nestjs/common";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { AdminRepository } from "./admin.repository.js";
import { AdminController } from "./admin.controller.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";
import { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";
import { MediaModule } from "../media/media.module.js";

@Module({
    imports: [MediaModule],
    controllers: [AdminController],
    providers: [
        AdminIngestionService,
        AdminTranscodingService,
        AdminRepository,
        MediaTelemetryGateway,
    ],
    exports: [AdminIngestionService, AdminTranscodingService],
})
export class AdminModule {}
