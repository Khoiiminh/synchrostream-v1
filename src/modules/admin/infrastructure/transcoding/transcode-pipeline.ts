import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import * as path from "path";
import * as fs from "fs";
import { Readable } from "stream";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import type { TranscodePhase } from "./transcode-queue.contract.js";

export type TranscodeProgressListener = (
    phase: TranscodePhase,
    percent: number,
) => void;

/**
 * Worker-only: downloads the mezzanine from R2, encodes the HLS/CMAF ladder
 * with ffmpeg and uploads the output. Throws on any failure and leaves the
 * movie status to the caller, which decides between retrying and FAILED.
 */
@Injectable()
export class TranscodePipeline implements OnModuleInit {
    private readonly logger = new Logger(TranscodePipeline.name);

    constructor(
        private readonly r2: CloudflareR2Provider,
        private readonly configService: ConfigService,
    ) {}

    onModuleInit() {
        try {
            this.logger.log({
                message: "Using bundled FFmpeg binary",
                path: ffmpegInstaller.path,
            });
            ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        } catch (error) {
            this.logger.error({
                message: "Failed to configure FFmpeg binary path",
                err: error,
            });
        }
    }

    private runFfmpegAsPromise(
        command: ffmpeg.FfmpegCommand,
        onProgress: TranscodeProgressListener,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            command
                .on("start", (cmdStr: string) => {
                    this.logger.debug({
                        message: "FFmpeg started",
                        command: cmdStr,
                    });
                })
                .on("progress", (progress: { percent?: number }) => {
                    if (typeof progress.percent === "number") {
                        onProgress("ENCODING", progress.percent);
                    }
                })
                .on("end", () => {
                    resolve();
                })
                .on("error", (err: Error, _stdout: string, stderr: string) => {
                    this.logger.error({ message: "FFmpeg failed", err });
                    this.logger.debug({ message: "FFmpeg stderr", stderr });
                    reject(err);
                })
                .run();
        });
    }

    /** Returns the R2 key of the master manifest. */
    async run({
        movieId,
        mezzanineKey,
        onProgress = () => {},
    }: {
        movieId: string;
        mezzanineKey: string;
        onProgress?: TranscodeProgressListener;
    }): Promise<string> {
        this.logger.log({ message: "Transcode started", movieId });

        const baseTempDir =
            this.configService.get<string>("TRANSCODE_TEMP_DIR") ||
            "D:/synchrostream_temp";

        const tmpDir = path.join(baseTempDir, `transcode-${movieId}`);
        const localInputPath = path.join(tmpDir, `mezzanine.mp4`);
        const outDir360p = path.join(tmpDir, "360p");
        const outDir804p = path.join(tmpDir, "804p");

        try {
            // A retried attempt starts from a clean workspace.
            if (fs.existsSync(tmpDir))
                fs.rmSync(tmpDir, { recursive: true, force: true });
            fs.mkdirSync(outDir360p, { recursive: true });
            fs.mkdirSync(outDir804p, { recursive: true });

            // 1. Stream the input file from R2 onto local temp storage.
            onProgress("DOWNLOADING", 0);
            this.logger.debug({ message: "Downloading source file", movieId });
            const masterStream = await this.r2.getObjectStream(mezzanineKey);

            if (!masterStream) {
                throw new Error(
                    `Cloud asset retrieval failed: Received an unreadable object stream reference for ${mezzanineKey}`,
                );
            }

            await this.downloadToFile(masterStream, localInputPath, movieId);
            onProgress("DOWNLOADING", 100);

            if (!fs.existsSync(localInputPath)) {
                throw new Error(
                    `Media Engine Panic: Target input track missing on local directory layer.`,
                );
            }

            const stats = fs.statSync(localInputPath);
            if (stats.size === 0) {
                throw new Error(
                    `Media Engine Panic: Target file size resolved to 0 bytes. Stream truncated.`,
                );
            }

            this.logger.debug({
                message: "Source file verified; starting FFmpeg ladder",
                movieId,
                sizeMb: Number((stats.size / (1024 * 1024)).toFixed(2)),
            });

            // 2. Multi-variant HLS (CMAF fMP4) encode, both renditions in one run.
            const ffmpegCommand = ffmpeg(localInputPath)
                .inputOptions(["-re"])

                // --- Rendition 1: 360p ---
                .output(path.join(outDir360p, "index.m3u8"))
                .outputOptions([
                    "-c:v libx264",
                    "-b:v 800k",
                    "-maxrate 856k",
                    "-bufsize 1200k",
                    "-s 640x360",
                    "-c:a aac",
                    "-b:a 96k",
                    "-g 48", // IDR keyframe every 48 frames (2 s at 24 fps)
                    "-keyint_min 48",
                    "-sc_threshold 0", // keep scene cuts from shifting chunk boundaries
                    "-f hls",
                    "-hls_time 4",
                    "-hls_playlist_type vod",
                    "-hls_segment_type fmp4", // CMAF fragmented MP4 (.m4s)
                    "-hls_fmp4_init_filename",
                    path.join(outDir360p, "init.mp4"),
                    `-hls_segment_filename ${path.join(outDir360p, "chunk_%03d.m4s")}`,
                ])
                // --- Rendition 2: 804p ---
                .output(path.join(outDir804p, "index.m3u8"))
                .outputOptions([
                    "-c:v libx264",
                    "-b:v 4500k",
                    "-maxrate 4815k",
                    "-bufsize 7000k",
                    "-s 1430x804",
                    "-c:a aac",
                    "-b:a 128k",
                    "-g 48",
                    "-keyint_min 48",
                    "-sc_threshold 0",
                    "-f hls",
                    "-hls_time 4",
                    "-hls_playlist_type vod",
                    "-hls_segment_type fmp4",
                    "-hls_fmp4_init_filename",
                    path.join(outDir804p, "init.mp4"),
                    `-hls_segment_filename ${path.join(outDir804p, "chunk_%03d.m4s")}`,
                ]);

            this.logger.debug({ message: "Encoding variants", movieId });
            onProgress("ENCODING", 0);
            await this.runFfmpegAsPromise(ffmpegCommand, onProgress);
            onProgress("ENCODING", 100);
            this.logger.log({
                message: "Encoding completed; uploading HLS output",
                movieId,
            });

            // 3. Master manifest.
            const masterManifestContent =
                `#EXTM3U\n` +
                `#EXT-X-VERSION:3\n` +
                `#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n` +
                `360p/index.m3u8\n` +
                `#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1430x804\n` +
                `804p/index.m3u8\n`;

            fs.writeFileSync(
                path.join(tmpDir, "master.m3u8"),
                masterManifestContent,
                "utf-8",
            );

            // 4. Upload everything except the source mezzanine.
            const uploads = listFilesRecursively(tmpDir).filter(
                (file) => !file.endsWith("mezzanine.mp4"),
            );
            this.logger.debug({
                message: "Uploading HLS artifacts to R2",
                movieId,
                count: uploads.length,
            });

            onProgress("UPLOADING", 0);
            for (const [index, localFilePath] of uploads.entries()) {
                const relativePath = path
                    .relative(tmpDir, localFilePath)
                    .replace(/\\/g, "/");
                const destinationR2Key = `film/${movieId}/${relativePath}`;
                const contentType = contentTypeFor(localFilePath);

                const uploadBody: Readable = localFilePath.endsWith(".m3u8")
                    ? Readable.from(
                          sanitizeManifest(
                              fs.readFileSync(localFilePath, "utf-8"),
                              movieId,
                          ),
                      )
                    : fs.createReadStream(localFilePath);

                this.logger.debug({
                    message: "Uploading HLS artifact",
                    key: destinationR2Key,
                    contentType,
                });

                await this.r2.uploadStream({
                    key: destinationR2Key,
                    stream: uploadBody,
                    contentType,
                });
                onProgress(
                    "UPLOADING",
                    Math.round(((index + 1) / uploads.length) * 100),
                );
            }

            return `film/${movieId}/master.m3u8`;
        } finally {
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                    this.logger.debug({
                        message: "Removed transcode workspace",
                        movieId,
                    });
                }
            } catch (cleanupError) {
                this.logger.error({
                    message: "Failed to remove transcode workspace",
                    movieId,
                    dir: tmpDir,
                    err: cleanupError,
                });
            }
        }
    }

    private downloadToFile(
        source: Readable,
        destination: string,
        movieId: string,
    ): Promise<void> {
        const inputWriteStream = fs.createWriteStream(destination);

        return new Promise<void>((resolve, reject) => {
            let bytesReceived = 0;
            let isSettled = false;

            const safeReject = (error: Error) => {
                if (isSettled) return;
                isSettled = true;
                inputWriteStream.destroy();
                reject(error);
            };

            source.on("data", (chunk: Buffer) => {
                bytesReceived += chunk.length;
            });

            source.on("error", (error) => {
                safeReject(
                    new Error(`R2 Stream Download Failure: ${error.message}`),
                );
            });

            inputWriteStream.on("error", (error) => {
                safeReject(
                    new Error(
                        `Local File Write Storage Failure: ${error.message}`,
                    ),
                );
            });

            // 'close' is the definitive end of the write stream's lifecycle.
            inputWriteStream.on("close", () => {
                if (bytesReceived === 0) {
                    return safeReject(
                        new Error(
                            `Zero bytes written to disk. Cloud file is not fully propagated yet.`,
                        ),
                    );
                }
                this.logger.debug({
                    message: "Source file downloaded",
                    movieId,
                });
                if (isSettled) return;
                isSettled = true;
                resolve();
            });

            source.pipe(inputWriteStream);
        });
    }
}

function listFilesRecursively(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((entry) => {
        const filePath = path.join(dir, entry);
        return fs.statSync(filePath).isDirectory()
            ? listFilesRecursively(filePath)
            : [filePath];
    });
}

export function contentTypeFor(file: string): string {
    if (file.endsWith(".m3u8")) return "application/x-mpegURL";
    if (file.endsWith(".ts")) return "video/mp2t";
    if (file.endsWith(".m4s")) return "video/iso.segment";
    if (file.endsWith(".mpd")) return "application/dash+xml";
    if (file.endsWith(".mp4")) return "video/mp4";
    return "application/octet-stream";
}

/**
 * ffmpeg writes the init/segment paths it was given, which are absolute local
 * paths. Strip them so the playlists reference files relative to themselves.
 */
export function sanitizeManifest(content: string, movieId: string): string {
    const fileUrlRegex = new RegExp(
        `file:///?D:[/\\\\][^\n\r]*?${movieId}[/\\\\](360p|804p)[/\\\\]`,
        "g",
    );
    const absolutePathRegex = new RegExp(
        `D:[/\\\\][^\n\r]*?${movieId}[/\\\\](360p|804p)[/\\\\]`,
        "g",
    );
    let result = content
        .replace(fileUrlRegex, "")
        .replace(absolutePathRegex, "");
    for (const rendition of ["360p", "804p"]) {
        result = result
            .split(`transcode-${movieId}/${rendition}/`)
            .join("")
            .split(`transcode-${movieId}\\${rendition}\\`)
            .join("");
    }
    return result;
}
