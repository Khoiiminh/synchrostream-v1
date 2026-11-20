import { Module } from "@nestjs/common";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { AdminController } from "./presentation/admin.controller.js";
import { MediaTelemetryGateway } from "./presentation/admin-media-telemetry.gateway.js";
import { MediaModule } from "../media/media.module.js";
import { TranscodeTelemetryRelay } from "./infrastructure/transcoding/transcode-telemetry.relay.js";
import { ADMIN_API_BINDINGS } from "./infrastructure/admin.bindings.js";
import type { AdminTelemetryBroadcastPort } from "./application/ports/collaborators.port.js";
import { ADMIN_TELEMETRY_BROADCAST } from "./application/ports/tokens.js";

// The /telemetry gateway is a presentation class, so it is bound here rather
// than in infrastructure/admin.bindings.ts.
type Implements<Port, Adapter extends Port> = Adapter;
export type GatewayCheck = Implements<
    AdminTelemetryBroadcastPort,
    MediaTelemetryGateway
>;

@Module({
    imports: [MediaModule],
    controllers: [AdminController],
    providers: [
        ...ADMIN_API_BINDINGS,
        AdminIngestionService,
        MediaTelemetryGateway,
        TranscodeTelemetryRelay,
        {
            provide: ADMIN_TELEMETRY_BROADCAST,
            useExisting: MediaTelemetryGateway,
        },
    ],
    exports: [AdminIngestionService],
})
export class AdminModule {}
