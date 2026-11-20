import { Module } from "@nestjs/common";
import { LiveKitService } from "./livekit.service.js";
import { LiveKitController } from "./presentation/livekit.controller.js";
import { LIVEKIT_PORT_BINDINGS } from "./infrastructure/livekit.bindings.js";
import { LIVEKIT_MEDIA_SESSIONS } from "./queries/livekit-media-sessions.js";
import { WatchPartyContractsModule } from "../watch-party/queries/watch-party-contracts.module.js";

@Module({
    imports: [WatchPartyContractsModule],
    controllers: [LiveKitController],
    providers: [
        ...LIVEKIT_PORT_BINDINGS,
        LiveKitService,
        { provide: LIVEKIT_MEDIA_SESSIONS, useExisting: LiveKitService },
    ],
    exports: [LIVEKIT_MEDIA_SESSIONS],
})
export class LiveKitApplicationModule {}
