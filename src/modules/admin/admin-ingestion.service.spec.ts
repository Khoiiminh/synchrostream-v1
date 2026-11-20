import { AdminIngestionService } from "./admin-ingestion.service.js";
import type { MovieCatalogWrites as AdminRepository } from "../media/queries/movie-catalog-writes.js";
import type { MediaTelemetryGateway } from "./presentation/admin-media-telemetry.gateway.js";
import type { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";

const MOVIE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function setup() {
    const repository = {
        generateMovieId: jest.fn().mockResolvedValue(MOVIE_ID),
        insertProcessingMovie: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const r2 = {
        startMultiPartUpload: jest.fn().mockResolvedValue("upload-1"),
        completeMultiPartUpload: jest.fn().mockResolvedValue(undefined),
    };
    const transcoding = {
        enqueueTranscode: jest.fn().mockResolvedValue(undefined),
    };
    const gateway = { broadcastMovieStatusUpdate: jest.fn() };
    const service = new AdminIngestionService(
        repository as unknown as AdminRepository,
        r2 as unknown as CloudflareR2Provider,
        transcoding,
        gateway as unknown as MediaTelemetryGateway,
    );
    return { service, repository, r2, transcoding, gateway };
}

async function initiateAndFinalize(ctx: ReturnType<typeof setup>) {
    await ctx.service.initiateMovieUpload({
        title: "T",
        genre: "G",
        description: "D",
    });
    return ctx.service.finalizeMovieUpload({
        movieId: MOVIE_ID,
        uploadId: "upload-1",
        parts: [
            { PartNumber: 2, ETag: "b" },
            { PartNumber: 1, ETag: "a" },
        ],
    });
}

describe("AdminIngestionService.finalizeMovieUpload", () => {
    it("completes the R2 upload, then enqueues the transcode (no ffmpeg in the API)", async () => {
        const ctx = setup();

        const result = await initiateAndFinalize(ctx);

        expect(ctx.r2.completeMultiPartUpload).toHaveBeenCalledWith({
            key: `raw-mezzanines/${MOVIE_ID}.mp4`,
            uploadId: "upload-1",
            parts: [
                { PartNumber: 1, ETag: "a" },
                { PartNumber: 2, ETag: "b" },
            ],
        });
        expect(ctx.transcoding.enqueueTranscode).toHaveBeenCalledWith(MOVIE_ID);
        expect(
            ctx.r2.completeMultiPartUpload.mock.invocationCallOrder[0],
        ).toBeLessThan(
            ctx.transcoding.enqueueTranscode.mock.invocationCallOrder[0],
        );
        // Unchanged HTTP response shape.
        expect(Object.keys(result).sort()).toEqual([
            "message",
            "movieId",
            "objectKey",
        ]);
        expect(result.message).toContain(MOVIE_ID);
        expect(result).toMatchObject({
            objectKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            movieId: MOVIE_ID,
        });
        expect(ctx.repository.markFailed).not.toHaveBeenCalled();
    });

    it("still answers success when the queue is down, but marks the movie FAILED and tells the UI", async () => {
        const ctx = setup();
        ctx.transcoding.enqueueTranscode.mockRejectedValue(
            new Error("redis down"),
        );

        const result = await initiateAndFinalize(ctx);

        expect(result.movieId).toBe(MOVIE_ID);
        expect(ctx.repository.markFailed).toHaveBeenCalledWith(MOVIE_ID);
        expect(ctx.gateway.broadcastMovieStatusUpdate).toHaveBeenCalledWith({
            movieId: MOVIE_ID,
            status: "FAILED",
        });
    });

    it("does not enqueue when completing the multipart upload fails", async () => {
        const ctx = setup();
        ctx.r2.completeMultiPartUpload.mockRejectedValue(new Error("r2"));

        await expect(initiateAndFinalize(ctx)).rejects.toThrow(
            "Multipart closure operation failed: r2",
        );
        expect(ctx.transcoding.enqueueTranscode).not.toHaveBeenCalled();
    });
});
