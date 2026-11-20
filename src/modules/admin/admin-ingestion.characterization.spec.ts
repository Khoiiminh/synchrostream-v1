import {
    BadRequestException,
    HttpException,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { AdminIngestionService } from "./admin-ingestion.service.js";
import type { AdminRepository } from "./admin.repository.js";
import type { AdminTranscodingService } from "./admin-transcoding.service.js";
import type { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";
import type { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";

/*
 * Characterization of the upload flow (plan B3), written before the split
 * into use cases: initiate, chunks, finalize, the 30-minute session TTL swept
 * every 10 minutes, and abort-on-shutdown. Only setup() knows the wiring.
 */

const MOVIE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const KEY = `raw-mezzanines/${MOVIE}.mp4`;

function setup() {
    const catalog = {
        generateMovieId: jest.fn().mockResolvedValue(MOVIE),
        insertProcessingMovie: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        markFailedIfProcessing: jest.fn().mockResolvedValue(undefined),
    };
    const storage = {
        startMultiPartUpload: jest.fn().mockResolvedValue("upload-1"),
        uploadPart: jest.fn().mockResolvedValue('"etag-1"'),
        completeMultiPartUpload: jest.fn().mockResolvedValue(undefined),
        abortMultiPartUpload: jest.fn().mockResolvedValue(undefined),
    };
    const queue = { enqueueTranscode: jest.fn().mockResolvedValue(undefined) };
    const broadcast = { broadcastMovieStatusUpdate: jest.fn() };
    const service = new AdminIngestionService(
        catalog as unknown as AdminRepository,
        storage as unknown as CloudflareR2Provider,
        queue as unknown as AdminTranscodingService,
        broadcast as unknown as MediaTelemetryGateway,
    );
    return { service, catalog, storage, queue, broadcast };
}

type Ctx = ReturnType<typeof setup>;

const initiate = (ctx: Ctx) =>
    ctx.service.initiateMovieUpload({
        title: "Title",
        genre: "Drama",
        description: "About",
    });

async function expectHttp(
    promise: Promise<unknown>,
    type: typeof HttpException,
    status: number,
    message: string,
) {
    const error: unknown = await promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(type);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).message).toBe(message);
}

beforeEach(() => {
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe("initiateMovieUpload", () => {
    it("starts an R2 multipart upload and records a PROCESSING movie", async () => {
        const ctx = setup();

        const result = await initiate(ctx);

        expect(result).toEqual({
            movieId: MOVIE,
            uploadId: "upload-1",
            objectKey: KEY,
        });
        expect(ctx.storage.startMultiPartUpload).toHaveBeenCalledWith(KEY);
        expect(ctx.catalog.insertProcessingMovie).toHaveBeenCalledWith(
            MOVIE,
            "Title",
            JSON.stringify({ genre: "Drama", description: "About" }),
        );
    });

    it.each([
        ["R2", "startMultiPartUpload"],
        ["the database", "insertProcessingMovie"],
    ] as const)(
        "a failure in %s is a 400 with its message",
        async (_where, fn) => {
            const ctx = setup();
            const target =
                fn === "startMultiPartUpload" ? ctx.storage : ctx.catalog;
            (target[fn as keyof typeof target] as jest.Mock).mockRejectedValue(
                new Error("nope"),
            );

            await expectHttp(
                initiate(ctx),
                BadRequestException,
                400,
                "Initialization vector failure: nope",
            );
            // No session: chunks for it are refused.
            await expectHttp(
                ctx.service.processChunkIngestion({
                    movieId: MOVIE,
                    uploadId: "upload-1",
                    partNumber: 1,
                    fileBuffer: Buffer.from("x"),
                }),
                NotFoundException,
                404,
                "Ingestion pipeline session has expired",
            );
        },
    );
});

describe("processChunkIngestion", () => {
    const chunk = (ctx: Ctx, uploadId = "upload-1") =>
        ctx.service.processChunkIngestion({
            movieId: MOVIE,
            uploadId,
            partNumber: 3,
            fileBuffer: Buffer.from("bytes"),
        });

    it("uploads the part to the session's object and returns its etag", async () => {
        const ctx = setup();
        await initiate(ctx);

        await expect(chunk(ctx)).resolves.toEqual({ etag: '"etag-1"' });
        expect(ctx.storage.uploadPart).toHaveBeenCalledWith({
            key: KEY,
            uploadId: "upload-1",
            partNumber: 3,
            body: Buffer.from("bytes"),
        });
    });

    it("an unknown movie is 404 expired", async () => {
        await expectHttp(
            chunk(setup()),
            NotFoundException,
            404,
            "Ingestion pipeline session has expired",
        );
    });

    it("a different upload id is 404 mismatch", async () => {
        const ctx = setup();
        await initiate(ctx);

        await expectHttp(
            chunk(ctx, "other"),
            NotFoundException,
            404,
            "Ingestion session is mismatch",
        );
        expect(ctx.storage.uploadPart).not.toHaveBeenCalled();
    });

    it("an R2 failure is a 400 naming the part; the session survives", async () => {
        const ctx = setup();
        await initiate(ctx);
        ctx.storage.uploadPart.mockRejectedValueOnce(new Error("timeout"));

        await expectHttp(
            chunk(ctx),
            BadRequestException,
            400,
            "Chunk ingestion failure on part 3: timeout",
        );
        await expect(chunk(ctx)).resolves.toEqual({ etag: '"etag-1"' });
    });
});

describe("finalizeMovieUpload", () => {
    const finalize = (ctx: Ctx, uploadId = "upload-1") =>
        ctx.service.finalizeMovieUpload({
            movieId: MOVIE,
            uploadId,
            parts: [
                { PartNumber: 2, ETag: "b" },
                { PartNumber: 1, ETag: "a" },
            ],
        });

    it("returns the exact confirmation and ends the session", async () => {
        const ctx = setup();
        await initiate(ctx);

        await expect(finalize(ctx)).resolves.toEqual({
            message: `Mezzanine master file successfully consolidated on storage bucket. Background multi-variant HLS encoding matrix initialized for Movie ID: ${MOVIE}.`,
            objectKey: KEY,
            movieId: MOVIE,
        });
        await expectHttp(
            finalize(ctx),
            NotFoundException,
            404,
            "Ingestion pipeline session has expired",
        );
    });

    it("unknown and mismatched sessions are 404 and complete nothing", async () => {
        const ctx = setup();
        await expectHttp(
            finalize(ctx),
            NotFoundException,
            404,
            "Ingestion pipeline session has expired",
        );

        await initiate(ctx);
        await expectHttp(
            finalize(ctx, "other"),
            NotFoundException,
            404,
            "Ingestion session is mismatch",
        );
        expect(ctx.storage.completeMultiPartUpload).not.toHaveBeenCalled();
        // A mismatch does not end the real session.
        await expect(finalize(ctx)).resolves.toMatchObject({ movieId: MOVIE });
    });

    it("an R2 failure is a 400 and still ends the session", async () => {
        const ctx = setup();
        await initiate(ctx);
        ctx.storage.completeMultiPartUpload.mockRejectedValueOnce(
            new Error("r2"),
        );

        await expectHttp(
            finalize(ctx),
            BadRequestException,
            400,
            "Multipart closure operation failed: r2",
        );
        await expectHttp(
            finalize(ctx),
            NotFoundException,
            404,
            "Ingestion pipeline session has expired",
        );
    });

    it("a queue outage after a good upload marks FAILED (unconditionally) and broadcasts once", async () => {
        const ctx = setup();
        await initiate(ctx);
        ctx.queue.enqueueTranscode.mockRejectedValue(new Error("redis"));

        await expect(finalize(ctx)).resolves.toMatchObject({ movieId: MOVIE });
        expect(ctx.catalog.markFailed).toHaveBeenCalledWith(MOVIE);
        expect(ctx.catalog.markFailedIfProcessing).not.toHaveBeenCalled();
        expect(ctx.broadcast.broadcastMovieStatusUpdate.mock.calls).toEqual([
            [{ movieId: MOVIE, status: "FAILED" }],
        ]);
    });

    it("a failed FAILED-marking is logged, not thrown", async () => {
        const ctx = setup();
        await initiate(ctx);
        ctx.queue.enqueueTranscode.mockRejectedValue(new Error("redis"));
        ctx.catalog.markFailed.mockRejectedValue(new Error("db"));

        await expect(finalize(ctx)).resolves.toMatchObject({ movieId: MOVIE });
        expect(ctx.broadcast.broadcastMovieStatusUpdate).toHaveBeenCalled();
    });
});

describe("stale session sweeper", () => {
    const MIN = 60_000;

    it("every 10 minutes aborts sessions older than 30 minutes and marks them FAILED", async () => {
        jest.useFakeTimers({ now: Date.UTC(2026, 10, 20) });
        const ctx = setup();
        ctx.service.onModuleInit();
        await initiate(ctx);

        // At 30 min the session is exactly at the TTL: kept (strictly older only).
        jest.advanceTimersByTime(30 * MIN);
        expect(ctx.storage.abortMultiPartUpload).not.toHaveBeenCalled();

        // Next sweep at 40 min: expired.
        jest.advanceTimersByTime(10 * MIN);
        await Promise.resolve();
        expect(ctx.storage.abortMultiPartUpload).toHaveBeenCalledWith({
            key: KEY,
            uploadId: "upload-1",
        });
        expect(ctx.catalog.markFailed).toHaveBeenCalledWith(MOVIE);

        await expect(
            ctx.service.processChunkIngestion({
                movieId: MOVIE,
                uploadId: "upload-1",
                partNumber: 1,
                fileBuffer: Buffer.from("x"),
            }),
        ).rejects.toThrow("Ingestion pipeline session has expired");
        await ctx.service.onModuleDestroy();
    });

    it("a sweep with a failing R2 abort still ends the session", async () => {
        jest.useFakeTimers({ now: Date.UTC(2026, 10, 20) });
        const ctx = setup();
        ctx.service.onModuleInit();
        await initiate(ctx);
        ctx.storage.abortMultiPartUpload.mockRejectedValue(new Error("r2"));

        jest.advanceTimersByTime(40 * MIN);
        await Promise.resolve();
        expect(ctx.catalog.markFailed).toHaveBeenCalledWith(MOVIE);
        await ctx.service.onModuleDestroy();
        // Already evicted: shutdown has nothing left to abort.
        expect(ctx.catalog.markFailedIfProcessing).not.toHaveBeenCalled();
    });
});

describe("shutdown", () => {
    it("aborts every open upload and fails only movies still PROCESSING", async () => {
        const ctx = setup();
        ctx.service.onModuleInit();
        await initiate(ctx);

        await ctx.service.onModuleDestroy();

        expect(ctx.storage.abortMultiPartUpload).toHaveBeenCalledWith({
            key: KEY,
            uploadId: "upload-1",
        });
        expect(ctx.catalog.markFailedIfProcessing).toHaveBeenCalledWith(MOVIE);
        expect(ctx.catalog.markFailed).not.toHaveBeenCalled();
    });

    it("an abort failure is logged and skips the FAILED marking", async () => {
        const ctx = setup();
        await initiate(ctx);
        ctx.storage.abortMultiPartUpload.mockRejectedValue(new Error("r2"));

        await expect(ctx.service.onModuleDestroy()).resolves.toBeUndefined();
        expect(ctx.catalog.markFailedIfProcessing).not.toHaveBeenCalled();
    });
});
