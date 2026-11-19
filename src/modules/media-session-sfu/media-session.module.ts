import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { MediaSessionService } from "./media-session.service.js";
import { MediaOrchestrationService } from "./media-orchestration.service.js";
import { MediaSessionRepository } from "./media-session.repository.js";
import { WatchPartyContractsModule } from "../watch-party/queries/watch-party-contracts.module.js";

@Module({
    imports: [InfrastructureModule, WatchPartyContractsModule],

    // MediaSessionController (/v1/media-sessions/*) is intentionally NOT mounted.
    // The self-built SFU is out of scope, and its endpoints let any authenticated
    // user move any media session, LiveKit sessions included, between states,
    // bypassing the room lock and the outbox. Re-mount it only behind
    // membership/provider authorization when SFU work resumes.
    controllers: [],

    providers: [
        MediaSessionRepository,
        MediaSessionService,
        MediaOrchestrationService,
    ],

    exports: [MediaSessionService, MediaOrchestrationService],
})
export class MediaSessionModule {}
