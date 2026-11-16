import { Injectable } from "@nestjs/common";
import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { CatalogMovie, PlayableMovieRow } from "./media.types.js";

/** Read-side SQL for the `movies` table (playback and catalog). */
@Injectable()
export class MediaRepository {
    constructor(private readonly pg: PostgresProvider) {}

    async findPlayableMovie(
        movieId: string,
    ): Promise<PlayableMovieRow | undefined> {
        const result = await this.pg.query<PlayableMovieRow>(
            `
            SELECT id, title, hls_url, dash_url, status, is_cmaf_ready, metadata
            FROM movies
            WHERE id = $1 AND status = 'AVAILABLE'::processing_status;`,
            [movieId],
        );
        return result.rows[0];
    }

    async findAvailableCatalog(): Promise<CatalogMovie[]> {
        const result = await this.pg.query<CatalogMovie>(`
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
        `);
        return result.rows;
    }
}
