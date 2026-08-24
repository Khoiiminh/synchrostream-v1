import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { WatchPartyController } from "./watch-party.controller.js";
import { LiveKitTokenService } from "./livekit-token.service.js";

@Module({
    imports: [
        InfrastructureModule,
        JwtModule.register({ secret: process.env.JWT_SECRET || 'fallback-secret-key' }),
    ],
    controllers: [WatchPartyController],
    providers: [WatchPartyGateway, WatchPartyService, LiveKitTokenService],
    exports: [WatchPartyService]
})
export class WatchPartyModule {}