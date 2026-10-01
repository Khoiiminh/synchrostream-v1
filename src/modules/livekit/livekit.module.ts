import { LiveKitModule } from "@/shared/infrastructure/livekit/livekit.module.js";
import { LiveKitService } from "./livekit.service.js";
import { Module } from "@nestjs/common";
import { LiveKitController } from "./livekit.controller.js";
import { MediaSessionModule } from "../media-session-sfu/media-session.module.js";

@Module({
    imports: [
        LiveKitModule,
        MediaSessionModule,
    ],
    controllers: [
        LiveKitController,
    ],
    providers: [
        LiveKitService,
    ],
    exports: [
        LiveKitService,
    ]
})
export class LiveKitApplicationModule {}