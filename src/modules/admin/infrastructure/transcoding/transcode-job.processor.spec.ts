import { UnrecoverableError } from "bullmq";
import {
    TranscodeJobProcessor,
    type TranscodeJob,
} from "./transcode-job.processor.js";
import type { MovieCatalogWrites as AdminRepository } from "../../../media/queries/movie-catalog-writes.js";
import type { TranscodeProgressListener } from "./transcode-pipeline.js";
import type { TranscodeTelemetryMessage } from "./transcode-queue.contract.js";

type StatusMessage = Extract<TranscodeTelemetryMessage, { type: "status" }>;
type ProgressMessage = Extract<TranscodeTelemetryMessage, { type: "progress" }>;
type PublishMock = jest.Mock<Promise<void>, [TranscodeTelemetryMessage]>;

const MOVIE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const MANIFEST = `film/${MOVIE_ID}/master.m3u8`;

function setup() {
    const repository = {
        findMovieStatus: jest
            .fn()
            .mockResolvedValue({ id: MOVIE_ID, status: "PROCESSING" }),
        markProcessing: jest.fn().mockResolvedValue(undefined),
        markAvailable: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const pipeline = { run: jest.fn().mockResolvedValue(MANIFEST) };
    const telemetry: { publish: PublishMock } = {
        publish: jest.fn<Promise<void>, [TranscodeTelemetryMessage]>(() =>
            Promise.resolve(),
        ),
    };
    const updateProgress = jest.fn<Promise<void>, [object]>(() =>
        Promise.resolve(),
    );
    const processor = new TranscodeJobProcessor(
        repository as unknown as AdminRepository,
        pipeline,
        telemetry,
    );
    const job: TranscodeJob = {
        id: MOVIE_ID,
        data: {
            movieId: MOVIE_ID,
            mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
        updateProgress,
    };
    return { processor, repository, pipeline, telemetry, job, updateProgress };
}

const statuses = (telemetry: { publish: PublishMock }): StatusMessage[] =>
    telemetry.publish.mock.calls
        .map(([m]) => m)
        .filter((m): m is StatusMessage => m.type === "status");

describe("TranscodeJobProcessor (worker job handling)", () => {
    it("runs the pipeline and moves the movie PROCESSING → AVAILABLE", async () => {
        const { processor, repository, pipeline, telemetry, job } = setup();

        await expect(processor.process(job)).resolves.toEqual({
            hlsUrl: MANIFEST,
        });

        expect(repository.markProcessing).toHaveBeenCalledWith(MOVIE_ID);
        expect(pipeline.run).toHaveBeenCalledWith(
            expect.objectContaining({
                movieId: MOVIE_ID,
                mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            }),
        );
        expect(repository.markAvailable).toHaveBeenCalledWith(
            MOVIE_ID,
            MANIFEST,
        );
        expect(statuses(telemetry)).toEqual([
            { type: "status", movieId: MOVIE_ID, status: "PROCESSING" },
            {
                type: "status",
                movieId: MOVIE_ID,
                status: "AVAILABLE",
                hlsUrl: MANIFEST,
            },
        ]);
    });

    it("drops a job for a missing movie as unrecoverable, without running ffmpeg", async () => {
        const { processor, repository, pipeline, job } = setup();
        repository.findMovieStatus.mockResolvedValue(undefined);

        await expect(processor.process(job)).rejects.toBeInstanceOf(
            UnrecoverableError,
        );
        expect(pipeline.run).not.toHaveBeenCalled();
    });

    it("rethrows pipeline errors so BullMQ retries, without marking FAILED", async () => {
        const { processor, repository, pipeline, telemetry, job } = setup();
        pipeline.run.mockRejectedValue(new Error("ffmpeg exited 1"));

        await expect(processor.process(job)).rejects.toThrow("ffmpeg exited 1");
        expect(repository.markAvailable).not.toHaveBeenCalled();
        expect(repository.markFailed).not.toHaveBeenCalled();
        expect(statuses(telemetry).map((m) => m.status)).toEqual([
            "PROCESSING",
        ]);
    });

    it("publishes progress only when the whole percentage changes", async () => {
        const { processor, pipeline, telemetry, job, updateProgress } = setup();
        pipeline.run.mockImplementation(
            ({ onProgress }: { onProgress: TranscodeProgressListener }) => {
                onProgress("ENCODING", 10.2);
                onProgress("ENCODING", 10.8); // same whole percent: skipped
                onProgress("ENCODING", 11.1);
                onProgress("UPLOADING", 11); // new phase: published
                onProgress("UPLOADING", 140); // clamped
                return Promise.resolve(MANIFEST);
            },
        );

        await processor.process(job);

        const progress = telemetry.publish.mock.calls
            .map(([m]) => m)
            .filter((m): m is ProgressMessage => m.type === "progress")
            .map((m) => [m.phase, m.percent]);
        expect(progress).toEqual([
            ["ENCODING", 10],
            ["ENCODING", 11],
            ["UPLOADING", 11],
            ["UPLOADING", 100],
        ]);
        expect(updateProgress).toHaveBeenCalledTimes(4);
    });

    describe("onFailed", () => {
        it("keeps the movie PROCESSING while attempts remain", async () => {
            const { processor, repository, telemetry, job } = setup();
            await processor.onFailed(
                { ...job, attemptsMade: 1 },
                new Error("x"),
            );
            expect(repository.markFailed).not.toHaveBeenCalled();
            expect(telemetry.publish).not.toHaveBeenCalled();
        });

        it("marks FAILED and tells the UI after the last attempt", async () => {
            const { processor, repository, telemetry, job } = setup();
            await processor.onFailed(
                { ...job, attemptsMade: 3 },
                new Error("x"),
            );
            expect(repository.markFailed).toHaveBeenCalledWith(MOVIE_ID);
            expect(telemetry.publish).toHaveBeenCalledWith({
                type: "status",
                movieId: MOVIE_ID,
                status: "FAILED",
            });
        });

        it("treats an unrecoverable error as final on the first attempt", async () => {
            const { processor, repository, job } = setup();
            await processor.onFailed(
                { ...job, attemptsMade: 1 },
                new UnrecoverableError("gone"),
            );
            expect(repository.markFailed).toHaveBeenCalledWith(MOVIE_ID);
        });

        it("still publishes FAILED when the DB update fails", async () => {
            const { processor, repository, telemetry, job } = setup();
            repository.markFailed.mockRejectedValue(new Error("pg down"));
            await processor.onFailed(
                { ...job, attemptsMade: 3 },
                new Error("x"),
            );
            expect(telemetry.publish).toHaveBeenCalledWith(
                expect.objectContaining({ status: "FAILED" }),
            );
        });

        it("the attempt before the last is not final; the last one is", async () => {
            const { processor, repository, job } = setup();
            await processor.onFailed(
                { ...job, attemptsMade: 2 },
                new Error("x"),
            );
            expect(repository.markFailed).not.toHaveBeenCalled();
            await processor.onFailed(
                { ...job, attemptsMade: 3 },
                new Error("x"),
            );
            expect(repository.markFailed).toHaveBeenCalledTimes(1);
        });

        it("a job without an attempts option is final after one failure", async () => {
            const { processor, repository, job } = setup();
            await processor.onFailed(
                { ...job, attemptsMade: 1, opts: {} },
                new Error("x"),
            );
            expect(repository.markFailed).toHaveBeenCalledWith(MOVIE_ID);
        });

        it("an error named UnrecoverableError (another bullmq copy) is final", async () => {
            const { processor, repository, job } = setup();
            const foreign = Object.assign(new Error("gone"), {
                name: "UnrecoverableError",
            });
            await processor.onFailed({ ...job, attemptsMade: 1 }, foreign);
            expect(repository.markFailed).toHaveBeenCalledWith(MOVIE_ID);
        });

        it("ignores a failure event without a job", async () => {
            const { processor, repository } = setup();
            await processor.onFailed(undefined, new Error("x"));
            expect(repository.markFailed).not.toHaveBeenCalled();
        });
    });
});
