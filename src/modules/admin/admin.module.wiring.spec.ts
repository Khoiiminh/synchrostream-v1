import { Logger } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { MovieCatalogWrites } from "../media/queries/movie-catalog-writes.js";
import { AdminModule } from "./admin.module.js";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import { MediaTelemetryGateway } from "./presentation/admin-media-telemetry.gateway.js";
import { AdminTranscodingService } from "./infrastructure/transcoding/transcode-queue.adapter.js";
import { TranscodeTelemetryRelay } from "./infrastructure/transcoding/transcode-telemetry.relay.js";
import { TRANSCODE_QUEUE } from "./infrastructure/transcoding/transcode-queue.contract.js";
import {
    ADMIN_TELEMETRY_BROADCAST,
    MOVIE_CATALOG,
    OBJECT_STORAGE,
    TRANSCODE_QUEUE_PORT,
} from "./application/ports/tokens.js";

jest.mock("../../common/logging/logger.js", () => ({
    maskEmail: (email: string) => email,
}));

/*
 * The API's AdminModule resolves with its ports bound to the real adapters.
 * compile() runs no lifecycle hooks, and the BullMQ queue is replaced, so
 * nothing connects anywhere.
 */

let moduleRef: TestingModule;

beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    moduleRef = await Test.createTestingModule({
        imports: [
            ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
            AdminModule,
        ],
    })
        .overrideProvider(TRANSCODE_QUEUE)
        .useValue({ add: jest.fn(), close: jest.fn() })
        .compile();
});

describe("AdminModule wiring", () => {
    it.each([
        ["MOVIE_CATALOG", MOVIE_CATALOG, MovieCatalogWrites],
        ["OBJECT_STORAGE", OBJECT_STORAGE, CloudflareR2Provider],
        ["TRANSCODE_QUEUE_PORT", TRANSCODE_QUEUE_PORT, AdminTranscodingService],
        [
            "ADMIN_TELEMETRY_BROADCAST",
            ADMIN_TELEMETRY_BROADCAST,
            MediaTelemetryGateway,
        ],
    ] as const)("%s → the singleton %p", (_name, token, adapter) => {
        const bound = moduleRef.get<unknown>(token, { strict: false });
        expect(bound).toBeInstanceOf(adapter);
        expect(bound).toBe(moduleRef.get<unknown>(adapter, { strict: false }));
    });

    it("the facade's use cases share one session registry and the bound ports", () => {
        const service = moduleRef.get<
            AdminIngestionService,
            Record<string, Record<string, unknown>>
        >(AdminIngestionService);
        const sessions = service.sessions;
        expect(service.initiate.sessions).toBe(sessions);
        expect(service.chunk.sessions).toBe(sessions);
        expect(service.finalize.sessions).toBe(sessions);
        expect(service.initiate.catalog).toBe(moduleRef.get(MOVIE_CATALOG));
        expect(service.finalize.queue).toBe(
            moduleRef.get(TRANSCODE_QUEUE_PORT),
        );
        expect(service.finalize.broadcast).toBe(
            moduleRef.get(MediaTelemetryGateway),
        );
    });

    it("the telemetry relay re-emits through the gateway", () => {
        const relay = moduleRef.get<
            TranscodeTelemetryRelay,
            Record<string, unknown>
        >(TranscodeTelemetryRelay);
        expect(relay.gateway).toBe(moduleRef.get(MediaTelemetryGateway));
    });
});
