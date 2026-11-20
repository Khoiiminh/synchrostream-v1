import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { WatchPartyService } from "./watch-party.service.js";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import { WatchPartyController } from "./watch-party.controller.js";
import { LiveKitApplicationModule } from "../livekit/livekit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RoomLifecycleOutboxService } from "./infrastructure/outbox/room-lifecycle-outbox.service.js";
import { RoomLifecycleOutboxRepository } from "./infrastructure/persistence/room-lifecycle-outbox.repository.js";
import { WatchPartyRepository } from "./infrastructure/persistence/watch-party.repository.js";
import { RoomChatRelay } from "./room-chat.relay.js";
import { RoomChatRepository } from "./infrastructure/persistence/room-chat.repository.js";
import { WATCH_PARTY_PORT_BINDINGS } from "./infrastructure/watch-party.bindings.js";

@Module({
    imports: [
        InfrastructureModule,
        AuthModule,
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
        RoomChatRelay,
        RoomChatRepository,
        ...WATCH_PARTY_PORT_BINDINGS,
    ],

    exports: [WatchPartyService],
})
export class WatchPartyModule {}
