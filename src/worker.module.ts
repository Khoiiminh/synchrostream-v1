import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ENV_FILE_PATH } from "./common/config/load-env.js";
import { PostgresProvider } from "./shared/infrastructure/database/postgres.provider.js";
import { RedisCacheProvider } from "./shared/infrastructure/cache/redis-cache.provider.js";
import { CloudflareR2Provider } from "./shared/infrastructure/storage/cloudflare-r2.provider.js";
import { MediaCatalogCache } from "./modules/media/media-catalog.cache.js";
import { MovieCatalogWrites } from "./modules/media/queries/movie-catalog-writes.js";
import { ADMIN_WORKER_BINDINGS } from "./modules/admin/infrastructure/transcoding/worker.bindings.js";

/**
 * Root module of the transcode worker process (src/worker.ts). Deliberately
 * not AppModule: no HTTP server, no socket gateways, and only the
 * infrastructure the job needs (Postgres, R2, the catalog cache).
 */
@Module({
    imports: [
        ConfigModule.forRoot({ envFilePath: ENV_FILE_PATH, isGlobal: true }),
    ],
    providers: [
        PostgresProvider,
        RedisCacheProvider,
        CloudflareR2Provider,
        MediaCatalogCache,
        MovieCatalogWrites,
        ...ADMIN_WORKER_BINDINGS,
    ],
})
export class WorkerModule {}
