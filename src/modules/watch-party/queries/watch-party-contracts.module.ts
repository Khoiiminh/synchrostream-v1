import { Module } from "@nestjs/common";
import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { RoomAccessQuery } from "./room-access.query.js";
import { MediaSessionEvents } from "./media-session-events.js";

/**
 * Watch-party's public contract for other modules (refactor plan §6).
 *
 * Depends only on infrastructure, so LiveKit and media sessions can import it
 * while WatchPartyModule keeps importing them: no module cycle.
 */
@Module({
    imports: [InfrastructureModule],
    providers: [RoomAccessQuery, MediaSessionEvents],
    exports: [RoomAccessQuery, MediaSessionEvents],
})
export class WatchPartyContractsModule {}
