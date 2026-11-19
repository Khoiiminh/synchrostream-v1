import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import type { ConfigService } from "@nestjs/config";
import type { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";

/*
 * ffmpeg is mocked: the fake command records its arguments and, on run(),
 * writes the files real ffmpeg would (playlists with absolute paths, init
 * segments, chunks) so the upload/sanitise/cleanup logic runs for real.
 */
type Listener = (...args: unknown[]) => void;
interface FakeCommand {
    input: string;
    outputs: string[];
    outputOptions: string[][];
    listeners: Record<string, Listener>;
}
const mockFfmpegState: { commands: FakeCommand[]; fail?: Error } = {
    commands: [],
};

jest.mock("@ffmpeg-installer/ffmpeg", () => ({
    __esModule: true,
    default: { path: "/fake/ffmpeg" },
}));
jest.mock("fluent-ffmpeg", () => {
    const factory = (input: string) => {
        const command: FakeCommand = {
            input,
            outputs: [],
            outputOptions: [],
            listeners: {},
        };
        mockFfmpegState.commands.push(command);
        const api = {
            inputOptions: () => api,
            output: (file: string) => {
                command.outputs.push(file);
                return api;
            },
            outputOptions: (opts: string[]) => {
                command.outputOptions.push(opts);
                return api;
            },
            on: (event: string, cb: Listener) => {
                command.listeners[event] = cb;
                return api;
            },
            run: () => {
                setImmediate(() => {
                    if (mockFfmpegState.fail) {
                        command.listeners.error?.(
                            mockFfmpegState.fail,
                            "",
                            "stderr",
                        );
                        return;
                    }
                    for (const playlist of command.outputs) {
                        const dir = path.dirname(playlist);
                        const winDir = `D:\\synchrostream_temp\\transcode-${MOVIE_ID}\\${path.basename(dir)}\\`;
                        fs.writeFileSync(
                            playlist,
                            `#EXTM3U\n#EXT-X-MAP:URI="${winDir}init.mp4"\nchunk_000.m4s\n`,
                        );
                        fs.writeFileSync(path.join(dir, "init.mp4"), "init");
                        fs.writeFileSync(
                            path.join(dir, "chunk_000.m4s"),
                            "seg",
                        );
                    }
                    command.listeners.start?.("ffmpeg ...");
                    command.listeners.progress?.({ percent: 50 });
                    command.listeners.end?.();
                });
            },
        };
        return api;
    };
    factory.setFfmpegPath = jest.fn();
    return { __esModule: true, default: factory };
});

const MOVIE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

// Imported after jest.mock so the pipeline gets the fake ffmpeg.
import { TranscodePipeline, sanitizeManifest } from "./transcode-pipeline.js";

async function readAll(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
        chunks.push(Buffer.from(chunk as string | Buffer));
    return Buffer.concat(chunks).toString("utf-8");
}

function setup(source: Buffer = Buffer.from("raw video bytes")) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "transcode-spec-"));
    const uploads: Array<{ key: string; contentType: string; body: string }> =
        [];
    const r2 = {
        getObjectStream: jest.fn(() =>
            Promise.resolve(Readable.from([source])),
        ),
        uploadStream: jest.fn(
            async (u: {
                key: string;
                stream: Readable;
                contentType: string;
            }) => {
                uploads.push({
                    key: u.key,
                    contentType: u.contentType,
                    body: await readAll(u.stream),
                });
            },
        ),
    };
    const config = {
        get: (key: string) =>
            key === "TRANSCODE_TEMP_DIR" ? tempRoot : undefined,
    } as ConfigService;
    const pipeline = new TranscodePipeline(
        r2 as unknown as CloudflareR2Provider,
        config,
    );
    return { pipeline, r2, uploads, tempRoot };
}

describe("TranscodePipeline (ffmpeg mocked)", () => {
    beforeEach(() => {
        mockFfmpegState.commands = [];
        mockFfmpegState.fail = undefined;
    });

    it("encodes both renditions and uploads the HLS output to film/<id>/", async () => {
        const { pipeline, r2, uploads, tempRoot } = setup();
        const progress: Array<[string, number]> = [];

        const manifestKey = await pipeline.run({
            movieId: MOVIE_ID,
            mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            onProgress: (phase, percent) => progress.push([phase, percent]),
        });

        expect(manifestKey).toBe(`film/${MOVIE_ID}/master.m3u8`);
        expect(r2.getObjectStream).toHaveBeenCalledWith(
            `raw-mezzanines/${MOVIE_ID}.mp4`,
        );

        const [command] = mockFfmpegState.commands;
        expect(command.input).toMatch(/mezzanine\.mp4$/);
        expect(
            command.outputs.map((o) => path.basename(path.dirname(o))),
        ).toEqual(["360p", "804p"]);
        expect(command.outputOptions[0]).toContain("-s 640x360");
        expect(command.outputOptions[1]).toContain("-s 1430x804");

        const keys = uploads.map((u) => u.key).sort();
        expect(keys).toEqual(
            [
                "360p/chunk_000.m4s",
                "360p/index.m3u8",
                "360p/init.mp4",
                "804p/chunk_000.m4s",
                "804p/index.m3u8",
                "804p/init.mp4",
                "master.m3u8",
            ].map((k) => `film/${MOVIE_ID}/${k}`),
        );
        expect(keys.some((k) => k.includes("mezzanine"))).toBe(false);

        const byKey = Object.fromEntries(uploads.map((u) => [u.key, u]));
        expect(byKey[`film/${MOVIE_ID}/master.m3u8`].contentType).toBe(
            "application/x-mpegURL",
        );
        expect(byKey[`film/${MOVIE_ID}/360p/chunk_000.m4s`].contentType).toBe(
            "video/iso.segment",
        );
        expect(byKey[`film/${MOVIE_ID}/360p/init.mp4`].contentType).toBe(
            "video/mp4",
        );
        // Absolute local paths are stripped from the variant playlists.
        expect(byKey[`film/${MOVIE_ID}/360p/index.m3u8`].body).toContain(
            '#EXT-X-MAP:URI="init.mp4"',
        );

        expect(progress[0]).toEqual(["DOWNLOADING", 0]);
        expect(progress).toContainEqual(["ENCODING", 50]);
        expect(progress[progress.length - 1]).toEqual(["UPLOADING", 100]);

        // Workspace removed.
        expect(fs.readdirSync(tempRoot)).toEqual([]);
    });

    it("throws on an ffmpeg error, uploads nothing and cleans up", async () => {
        const { pipeline, uploads, tempRoot } = setup();
        mockFfmpegState.fail = new Error("ffmpeg exited with code 1");

        await expect(
            pipeline.run({
                movieId: MOVIE_ID,
                mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            }),
        ).rejects.toThrow("ffmpeg exited with code 1");
        expect(uploads).toEqual([]);
        expect(fs.readdirSync(tempRoot)).toEqual([]);
    });

    it("rejects an empty source object before running ffmpeg", async () => {
        const { pipeline } = setup(Buffer.alloc(0));

        await expect(
            pipeline.run({
                movieId: MOVIE_ID,
                mezzanineKey: `raw-mezzanines/${MOVIE_ID}.mp4`,
            }),
        ).rejects.toThrow(/Zero bytes written/);
        expect(mockFfmpegState.commands).toEqual([]);
    });
});

describe("sanitizeManifest", () => {
    it("strips file URLs and absolute Windows paths to the rendition folder", () => {
        const input =
            `#EXT-X-MAP:URI="file:///D:/tmp/transcode-${MOVIE_ID}/804p/init.mp4"\n` +
            `D:\\tmp\\transcode-${MOVIE_ID}\\360p\\chunk_001.m4s\n`;
        expect(sanitizeManifest(input, MOVIE_ID)).toBe(
            `#EXT-X-MAP:URI="init.mp4"\nchunk_001.m4s\n`,
        );
    });
});
