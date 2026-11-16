import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { WatchPartyController } from "./watch-party.controller.js";
import { MediaSessionModule } from "../media-session-sfu/media-session.module.js";
import { LiveKitApplicationModule } from "../livekit/livekit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RoomLifecycleOutboxService } from "./room-lifecycle-outbox.service.js";
import { RoomLifecycleOutboxRepository } from "./room-lifecycle-outbox.repository.js";
import { WatchPartyRepository } from "./watch-party.repository.js";

@Module({
    imports: [
        InfrastructureModule,
        AuthModule,
        MediaSessionModule,
        LiveKitApplicationModule,
        JwtModule.register({
            secret: process.env.JWT_SECRET || "fallback-secret-key",
        }),
    ],

    controllers: [WatchPartyController],

    providers: [
        WatchPartyGateway,
        WatchPartyService,
        RoomLifecycleOutboxService,
        WatchPartyRepository,
        RoomLifecycleOutboxRepository,
    ],

    exports: [WatchPartyService],
})
export class WatchPartyModule {}
