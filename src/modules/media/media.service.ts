import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";

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
        this.logger.log({ message: 'Resolving streaming manifest access parameters', movieId });

        const query = `
            SELECT id, title, hls_url, dash_url, status, is_cmaf_ready, metadata
            FROM movies 
            WHERE id = $1 AND status = 'AVAILABLE'::processing_status;`;

        let movie: any;
        try {
            const [result] = await this.pg.query<any>(query, [movieId]);
            movie = result;
        } catch (dbError) {
            this.logger.error({ message: 'Database connection execution fault during media query', movieId, error: (dbError as Error).message }, (dbError as Error).stack);
            throw dbError;
        }

        if (!movie) {
            this.logger.warn({ message: 'Media resolution failed: Movie missing or not in AVAILABLE state', movieId });
            throw new NotFoundException('The requested media asset is unavailable or does not exist.');
        }
        
        try {
            const presignedHlsUrl = await this.r2.generatePresignedUrl(movie.id);
            const durationMs = Date.now() - startTime;

            this.logger.log({ 
                message: 'Solo playback manifest generated successfully', 
                movieId, 
                title: movie.title,
                isCmafReady: movie.is_cmaf_ready,
                durationMs 
            });

            return {
                movieId: movie.id,
                title: movie.title,
                isCmafReady: movie.is_cmaf_ready,
                metadata: movie.metadata,
                streaming: {
                    hlsUrl: presignedHlsUrl,
                    dashUrl: movie.dash_url
                }
            };
        } catch (storageError) {
            this.logger.error({ message: 'Cloudflare R2 pre-signed URL generation failure', movieId, error: (storageError as Error).message }, (storageError as Error).stack);
            throw storageError;
        }
    }

    async getAvailableCatalog(): Promise<any[]> {
        this.logger.log('Fetching active, fully-transcoded movie catalog for user discovery platform.');

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

        const records = await this.pg.query<any>(queryText);
        return records.map((movie) => {
            let parsedMetadata = {};
            
            if (movie.metadata) {
                try {
                    // Check if metadata is wrapped in the driver structure
                    if (typeof movie.metadata === 'object' && 'value' in movie.metadata) {
                        parsedMetadata = typeof movie.metadata.value === 'string' 
                            ? JSON.parse(movie.metadata.value) 
                            : movie.metadata.value;
                    } else if (typeof movie.metadata === 'string') {
                        parsedMetadata = JSON.parse(movie.metadata);
                    } else {
                        parsedMetadata = movie.metadata;
                    }
                } catch (e) {
                    this.logger.error(`Failed parsing metadata block for movie ${movie.movieId}`, e);
                }
            }

            return {
                ...movie,
                metadata: parsedMetadata
            };
        });
    }
}