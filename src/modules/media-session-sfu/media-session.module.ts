import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { MediaSessionController } from "./media-session.controller.js";
import { MediaSessionService } from "./media-session.service.js";
import { MediaOrchestrationService } from "./media-orchestration.service.js";

@Module({
    imports: [
        InfrastructureModule,
    ],

    controllers: [
        MediaSessionController,
    ],

    providers: [
        MediaSessionService,
        MediaOrchestrationService,
    ],

    exports: [
        MediaSessionService,
        MediaOrchestrationService,
    ],
})
export class MediaSessionModule {}