import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { WatchPartyController } from "./watch-party.controller.js";
import { MediaSessionModule } from "../media-session-sfu/media-session.module.js";
import { LiveKitApplicationModule } from "../livekit/livekit.module.js";

@Module({
    imports: [
        InfrastructureModule,
        MediaSessionModule,
        LiveKitApplicationModule,
        JwtModule.register({
            secret: process.env.JWT_SECRET || "fallback-secret-key",
        }),
    ],

    controllers: [
        WatchPartyController
    ],

    providers: [
        WatchPartyGateway, 
        WatchPartyService,
    ],

    exports: [
        WatchPartyService
    ],
})
export class WatchPartyModule {}
