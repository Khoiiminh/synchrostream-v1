import { ConfigService } from "@nestjs/config";
import { AdminTranscodingService } from "./transcode-queue.adapter.js";
import {
    TRANSCODE_JOB_NAME,
    TRANSCODE_START_DELAY_MS,
    type TranscodeQueue,
} from "./transcode-queue.contract.js";

const MOVIE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function setup(env: Record<string, string> = {}) {
    const add = jest.fn<
        ReturnType<TranscodeQueue["add"]>,
        Parameters<TranscodeQueue["add"]>
    >(() => Promise.resolve({}));
    const close = jest.fn(() => Promise.resolve());
    const queue: TranscodeQueue = { add, close };
    const config = { get: (key: string) => env[key] } as ConfigService;
    return { add, close, service: new AdminTranscodingService(queue, config) };
}

describe("AdminTranscodingService (API enqueue path)", () => {
    it("enqueues one delayed, retried job per movie and nothing else", async () => {
        const { add, service } = setup();

        await service.enqueueTranscode(MOVIE_ID);

        expect(add).toHaveBeenCalledTimes(1);
        expect(add).toHaveBeenCalledWith(
            TRANSCODE_JOB_NAME,
            {
                movieId: MOVIE_ID,
                mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            },
            expect.objectContaining({
                jobId: MOVIE_ID,
                delay: TRANSCODE_START_DELAY_MS,
                attempts: 3,
                backoff: { type: "exponential", delay: 30_000 },
                removeOnComplete: true,
            }),
        );
    });

    it("reads the attempt budget from TRANSCODE_MAX_ATTEMPTS", async () => {
        const { add, service } = setup({ TRANSCODE_MAX_ATTEMPTS: "5" });
        await service.enqueueTranscode(MOVIE_ID);
        expect(add.mock.calls[0][2]).toMatchObject({ attempts: 5 });
    });

    it("falls back to 3 attempts for an invalid value", async () => {
        const { add, service } = setup({
            TRANSCODE_MAX_ATTEMPTS: "zero",
        });
        await service.enqueueTranscode(MOVIE_ID);
        expect(add.mock.calls[0][2]).toMatchObject({ attempts: 3 });
    });

    it("propagates queue errors to the caller", async () => {
        const { add, service } = setup();
        add.mockRejectedValue(new Error("redis down"));
        await expect(service.enqueueTranscode(MOVIE_ID)).rejects.toThrow(
            "redis down",
        );
    });

    it("closes the queue on shutdown", async () => {
        const { close, service } = setup();
        await service.onModuleDestroy();
        expect(close).toHaveBeenCalled();
    });
});
