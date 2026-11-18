/** Row of the single-movie playback query. */
export interface PlayableMovieRow {
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
