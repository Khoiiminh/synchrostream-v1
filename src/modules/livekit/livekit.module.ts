import { LiveKitModule } from "@/shared/infrastructure/livekit/livekit.module.js";
import { LiveKitService } from "./livekit.service.js";
import { LiveKitRepository } from "./livekit.repository.js";
import { Module } from "@nestjs/common";
import { LiveKitController } from "./livekit.controller.js";
import { MediaSessionService } from "./media-session.service.js";
import { MediaSessionRepository } from "./media-session.repository.js";
import { WatchPartyContractsModule } from "../watch-party/queries/watch-party-contracts.module.js";

@Module({
    imports: [LiveKitModule, WatchPartyContractsModule],
    controllers: [LiveKitController],
    providers: [
        LiveKitService,
        LiveKitRepository,
        MediaSessionService,
        MediaSessionRepository,
    ],
    exports: [LiveKitService],
})
export class LiveKitApplicationModule {}
