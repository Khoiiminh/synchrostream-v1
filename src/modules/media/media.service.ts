import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { MediaRepository } from "./media.repository.js";
import { MediaCatalogCache } from "./media-catalog.cache.js";
import type { CatalogMovie, PlayableMovieRow } from "./media.types.js";

/**
 * Metadata may arrive as a JSON object, a JSON string, or wrapped in a
 * driver `{ value }` envelope; normalise all three to the parsed value.
 */
function parseMetadata(raw: unknown): unknown {
    if (typeof raw === "string") return JSON.parse(raw);
    if (typeof raw === "object" && raw !== null && "value" in raw) {
        const { value } = raw;
        return typeof value === "string" ? JSON.parse(value) : value;
    }
    return raw;
}

@Injectable()
export class MediaService {
    private readonly logger = new Logger(MediaService.name);

    constructor(
        private readonly mediaRepository: MediaRepository,
        private readonly r2: CloudflareR2Provider,
        private readonly catalogCache: MediaCatalogCache,
    ) {}

    /**
     * Retrieves video profile details and return a secure, time-bounded presigned streaming URL
     */
    async resolveSoloPlayback(movieId: string) {
        const startTime = Date.now();
        this.logger.debug({
            message: "Resolving streaming manifest access parameters",
            movieId,
        });

        let movie: PlayableMovieRow | undefined;
        try {
            movie = await this.mediaRepository.findPlayableMovie(movieId);
        } catch (dbError) {
            this.logger.error({
                message:
                    "Database connection execution fault during media query",
                movieId,
                err: dbError,
            });
            throw dbError;
        }

        if (!movie) {
            this.logger.warn({
                message:
                    "Media resolution failed: Movie missing or not in AVAILABLE state",
                movieId,
            });
            throw new NotFoundException(
                "The requested media asset is unavailable or does not exist.",
            );
        }

        try {
            const presignedHlsUrl = this.r2.generatePresignedUrl(movie.id);
            const durationMs = Date.now() - startTime;

            this.logger.log({
                message: "Solo playback manifest generated successfully",
                movieId,
                title: movie.title,
                isCmafReady: movie.is_cmaf_ready,
                durationMs,
            });

            return {
                movieId: movie.id,
                title: movie.title,
                isCmafReady: movie.is_cmaf_ready,
                metadata: movie.metadata,
                streaming: {
                    hlsUrl: presignedHlsUrl,
                    dashUrl: movie.dash_url,
                },
            };
        } catch (storageError) {
            this.logger.error({
                message: "Cloudflare R2 pre-signed URL generation failure",
                movieId,
                err: storageError,
            });
            throw storageError;
        }
    }

    async getAvailableCatalog(): Promise<CatalogMovie[]> {
        this.logger.debug({ message: "Fetching available movie catalog" });

        // Cached as the final response shape; a miss or Redis outage reads
        // PostgreSQL exactly as before.
        const cached = await this.catalogCache.get();
        if (cached) return cached;

        const records = await this.mediaRepository.findAvailableCatalog();
        const catalog = records.map((movie) => {
            let parsedMetadata: unknown = {};

            if (movie.metadata) {
                try {
                    parsedMetadata = parseMetadata(movie.metadata);
                } catch (e) {
                    this.logger.error({
                        message: "Failed to parse movie metadata",
                        movieId: movie.movieId,
                        err: e,
                    });
                }
            }

            return {
                ...movie,
                metadata: parsedMetadata,
            };
        });

        await this.catalogCache.set(catalog);
        return catalog;
    }
}
