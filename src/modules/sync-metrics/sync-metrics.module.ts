import { Module } from "@nestjs/common";
import { SyncMetricsController } from "./sync-metrics.controller.js";
import { SyncMetricsService } from "./sync-metrics.service.js";

@Module({
    controllers: [SyncMetricsController],
    providers: [SyncMetricsService],
})
export class SyncMetricsModule {}
