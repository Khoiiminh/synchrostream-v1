import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";

/** Row of the single-movie playback query. */
interface PlayableMovieRow {
    id: string;
    title: string;
    hls_url: string | null;
    dash_url: string | null;
    status: string;
    is_cmaf_ready: boolean;
    /** JSONB column; shape is set by the admin ingestion form. */
    metadata: unknown;
}

/** Row of the catalog query (columns already aliased to camelCase). */
export interface CatalogMovie {
    movieId: string;
    title: string;
    status: string;
    isCmafReady: boolean;
    metadata: unknown;
    createdAt: Date;
}

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
        private readonly pg: PostgresProvider,
        private readonly r2: CloudflareR2Provider,
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

        const query = `
            SELECT id, title, hls_url, dash_url, status, is_cmaf_ready, metadata
            FROM movies 
            WHERE id = $1 AND status = 'AVAILABLE'::processing_status;`;

        let movie: PlayableMovieRow | undefined;
        try {
            const result = await this.pg.query<PlayableMovieRow>(query, [
                movieId,
            ]);
            movie = result.rows[0];
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

        const queryText = `
            SELECT
                id AS "movieId",
                title,
                status,
                is_cmaf_ready AS "isCmafReady",
                metadata,
                created_at AS "createdAt"
            FROM public.movies
            WHERE status = 'AVAILABLE' AND is_cmaf_ready = true
            ORDER BY title ASC
        `;

        const records = await this.pg.query<CatalogMovie>(queryText);
        return records.rows.map((movie) => {
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
    }
}
