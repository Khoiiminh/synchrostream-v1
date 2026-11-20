import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import type { MediaCatalogCache } from "../media/media-catalog.cache.js";
import { MovieCatalogWrites } from "../media/queries/movie-catalog-writes.js";
import {
    connectTestPostgres,
    resetDatabase,
} from "../../../test/integration/fixtures.js";

/*
 * Characterization of the `movies` writes behind ingestion and transcoding
 * (plan B3), on the disposable Postgres. Every write must drop the cached
 * catalog. Only build() knows which class holds the SQL.
 */

let pg: PostgresProvider;
let invalidations: number;

beforeAll(() => {
    pg = connectTestPostgres();
});
afterAll(async () => {
    await pg.onModuleDestroy();
});
beforeEach(async () => {
    await resetDatabase(pg);
    invalidations = 0;
});

function build() {
    const cache = {
        invalidate: () => {
            invalidations += 1;
            return Promise.resolve();
        },
    } as unknown as MediaCatalogCache;
    return new MovieCatalogWrites(pg, cache);
}

async function movie(id: string) {
    const { rows } = await pg.query<{
        title: string;
        status: string;
        metadata: unknown;
        hls_url: string | null;
        is_cmaf_ready: boolean;
    }>(
        `SELECT title, status, metadata, hls_url, is_cmaf_ready FROM public.movies WHERE id = $1`,
        [id],
    );
    return rows[0];
}

it("generates a fresh UUIDv7 without touching the table", async () => {
    const catalog = build();
    const a = await catalog.generateMovieId();
    const b = await catalog.generateMovieId();

    expect(a).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(b).not.toBe(a);
    expect(invalidations).toBe(0);
});

it("inserts a PROCESSING movie with its metadata and no manifest", async () => {
    const catalog = build();
    const id = await catalog.generateMovieId();

    await catalog.insertProcessingMovie(
        id,
        "Title",
        JSON.stringify({ genre: "Drama" }),
    );

    expect(await movie(id)).toEqual({
        title: "Title",
        status: "PROCESSING",
        metadata: { genre: "Drama" },
        hls_url: null,
        is_cmaf_ready: false,
    });
    expect(await catalog.findMovieStatus(id)).toEqual({
        id,
        status: "PROCESSING",
    });
    expect(invalidations).toBe(1);
});

it("an unknown movie has no status", async () => {
    expect(
        await build().findMovieStatus("00000000-0000-4000-8000-000000000000"),
    ).toBeUndefined();
});

it("PROCESSING → AVAILABLE stores the manifest and CMAF flag", async () => {
    const catalog = build();
    const id = await catalog.generateMovieId();
    await catalog.insertProcessingMovie(id, "T", "{}");

    await catalog.markAvailable(id, "film/x/master.m3u8");

    expect(await movie(id)).toMatchObject({
        status: "AVAILABLE",
        hls_url: "film/x/master.m3u8",
        is_cmaf_ready: true,
    });
    expect(invalidations).toBe(2);
});

it("markFailed and markProcessing set the status unconditionally", async () => {
    const catalog = build();
    const id = await catalog.generateMovieId();
    await catalog.insertProcessingMovie(id, "T", "{}");
    await catalog.markAvailable(id, "m.m3u8");

    await catalog.markFailed(id);
    expect((await movie(id)).status).toBe("FAILED");
    await catalog.markProcessing(id);
    expect((await movie(id)).status).toBe("PROCESSING");
    expect(invalidations).toBe(4);
});

it("markFailedIfProcessing leaves finished movies alone, but still invalidates", async () => {
    const catalog = build();
    const done = await catalog.generateMovieId();
    const running = await catalog.generateMovieId();
    await catalog.insertProcessingMovie(done, "Done", "{}");
    await catalog.insertProcessingMovie(running, "Running", "{}");
    await catalog.markAvailable(done, "m.m3u8");
    invalidations = 0;

    await catalog.markFailedIfProcessing(done);
    await catalog.markFailedIfProcessing(running);

    expect((await movie(done)).status).toBe("AVAILABLE");
    expect((await movie(running)).status).toBe("FAILED");
    expect(invalidations).toBe(2);
});
