import { InfrastructureModule } from "@/shared/infrastructure/infrastructure.module.js";
import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { MediaRepository } from "./media.repository.js";
import { MediaCatalogCache } from "./media-catalog.cache.js";
import { MovieCatalogWrites } from "./queries/movie-catalog-writes.js";

@Module({
    imports: [InfrastructureModule],
    controllers: [MediaController],
    exports: [MediaService, MovieCatalogWrites],
    providers: [
        MediaService,
        MediaRepository,
        MediaCatalogCache,
        MovieCatalogWrites,
    ],
})
export class MediaModule {}
