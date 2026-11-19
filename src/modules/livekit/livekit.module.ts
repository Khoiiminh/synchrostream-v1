import { LiveKitModule } from "@/shared/infrastructure/livekit/livekit.module.js";
import { LiveKitService } from "./livekit.service.js";
import { LiveKitRepository } from "./livekit.repository.js";
import { Module } from "@nestjs/common";
import { LiveKitController } from "./livekit.controller.js";
import { MediaSessionModule } from "../media-session-sfu/media-session.module.js";
import { WatchPartyContractsModule } from "../watch-party/queries/watch-party-contracts.module.js";

@Module({
    imports: [LiveKitModule, MediaSessionModule, WatchPartyContractsModule],
    controllers: [LiveKitController],
    providers: [LiveKitService, LiveKitRepository],
    exports: [LiveKitService],
})
export class LiveKitApplicationModule {}
