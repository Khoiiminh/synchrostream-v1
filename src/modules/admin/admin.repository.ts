import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { MediaCatalogCache } from "../media/media-catalog.cache.js";

/**
 * Write-side SQL for the `movies` table (ingestion and transcoding). Every
 * write drops the cached catalog so GET /media/catalog sees it at once.
 */
@Injectable()
export class AdminRepository {
    constructor(
        private readonly pg: PostgresProvider,
        private readonly catalogCache: MediaCatalogCache,
    ) {}

    async generateMovieId(): Promise<string> {
        const result = await this.pg.query<{ id: string }>(
            `SELECT uuidv7() AS id;`,
        );
        return result.rows[0].id;
    }

    async insertProcessingMovie(
        movieId: string,
        title: string,
        metadataJson: string,
    ): Promise<void> {
        await this.pg.query(
            `
                INSERT INTO movies (id, title, status, metadata, hls_url)
                VALUES ($1, $2, 'PROCESSING'::processing_status, $3::jsonb, NULL)
                RETURNING id;
            `,
            [movieId, title, metadataJson],
        );
        await this.catalogCache.invalidate();
    }

    async findMovieStatus(
        movieId: string,
    ): Promise<{ id: string; status: string } | undefined> {
        const result = await this.pg.query<{ id: string; status: string }>(
            `SELECT id, status FROM movies WHERE id = $1`,
            [movieId],
        );
        return result.rows[0];
    }

    async markProcessing(movieId: string): Promise<void> {
        await this.pg.query(
            `UPDATE movies SET status = 'PROCESSING'::processing_status WHERE id = $1;`,
            [movieId],
        );
        await this.catalogCache.invalidate();
    }

    async markFailed(movieId: string): Promise<void> {
        await this.pg.query(
            `UPDATE movies SET status = 'FAILED'::processing_status WHERE id = $1;`,
            [movieId],
        );
        await this.catalogCache.invalidate();
    }

    /** Only flips PROCESSING → FAILED; leaves finished movies alone. */
    async markFailedIfProcessing(movieId: string): Promise<void> {
        await this.pg.query(
            `
                UPDATE movies
                SET status = 'FAILED'::processing_status
                WHERE id = $1 AND status = 'PROCESSING'::processing_status;
            `,
            [movieId],
        );
        await this.catalogCache.invalidate();
    }

    async markAvailable(movieId: string, manifestKey: string): Promise<void> {
        await this.pg.query(
            `
                UPDATE movies
                SET
                    hls_url = $1,
                    status = 'AVAILABLE'::processing_status,
                    is_cmaf_ready = true
                WHERE id = $2;
            `,
            [manifestKey, movieId],
        );
        await this.catalogCache.invalidate();
    }
}
