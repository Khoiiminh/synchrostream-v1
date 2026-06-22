import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as path from "path";
import * as fs from 'fs';
import { ConfigService } from "@nestjs/config";
import { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";
import { Readable } from "stream";

@Injectable()
export class AdminTranscodingService implements OnModuleInit {
    private readonly logger = new Logger(AdminTranscodingService.name);

    constructor(
        private readonly pg: PostgresProvider,
        private readonly r2: CloudflareR2Provider,
        private readonly configService: ConfigService,
        private readonly telemetryGateway: MediaTelemetryGateway,
    ) {}

    onModuleInit() {
        try {
            this.logger.log(`Registering local binary target layer path for FFmpeg execution: ${ffmpegInstaller.path}`);
            ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        } catch (error) {
            this.logger.error(`Failed to assign runtime binary mapping path: ${(error as Error).message}`);
        }
    }

    private runFfmpegAsPromise(command: ffmpeg.FfmpegCommand): Promise<void> {
        return new Promise((resolve, reject) => {
            command
                .on('start', (cmdStr) => {
                    this.logger.debug(`Spawned native child process runner sequence command: ${cmdStr}`);
                })
                .on('end', () => {
                    resolve();
                })
                .on('error', (err, stdout, stderr) => {
                    this.logger.error(`FFmpeg execution failed: ${err.message}`);
                    this.logger.debug(`FFmpeg stderr: ${stderr}`)
                    reject(err);
                })
                .run();
        });
    }

    async initiateBackgroundTranscode(movieId: string): Promise<void> {
        this.logger.log(`Received background transcode request for Movie ID: ${movieId}`);
        // 1. Move DB verification where it belongs
        const checkMovieQuery = `SELECT id, status FROM movies WHERE id = $1`;
        const movies = await this.pg.query<{ id: string, status: string}>(checkMovieQuery, [movieId]);

        if (!movies || movies.length === 0) {
            this.logger.warn(`Transcode aborted: Movie ID ${movieId} not found in database`);
            throw new NotFoundException("Requested movie profile not found in database.");
        }

        const targetMovie = movies[0];
        const mezzanineKey = `raw-mezzanines/${targetMovie.id}.mp4`;

        this.logger.log(`Movie ${movieId} verified. Handing off to execution pipeline...`);

        const updateProcessing = `UPDATE movies SET status = 'PROCESSING'::processing_status WHERE id = $1;`;
        await this.pg.query(updateProcessing, [movieId]);

        /// TELEMETRY BROADCAST: Notify UI that transcoding has officially begun
        this.telemetryGateway.broadcastMovieStatusUpdate({ movieId, status: 'PROCESSING' });

        // 2. Offload execution asynchronously to fire-and-forget the HTTP worker loop
        this.executeTranscodePipeline({ movieId: targetMovie.id, mezzanineKey })
            .catch((err) => {
                this.logger.error(`Unhandled pipeline trigger fault for movie ${movieId}: ${err.message}`);
            });
    }

    /**
     * Spawns a fluent-ffmpeg execution pipeline to transform a mezzanine file into 
     * synchronous adaptive bitrates and streams them out to Cloudflare R2 bucket destination.
     */
    async executeTranscodePipeline({ movieId, mezzanineKey }: {movieId: string, mezzanineKey: string}): Promise<void> {
        this.logger.log(`Initializing media processing engine for Movie ID: ${movieId}`);

        const baseTempDir = this.configService.get<string>('TRANSCODE_TEMP_DIR') || 'D:/synchrostream_temp';

        // Setup structural operational paths under standard environment temp scopes
        const tmpDir = path.join(baseTempDir, `transcode-${movieId}`);
        const localInputPath = path.join(tmpDir, `mezzanine.mp4`);
        const outDir360p = path.join(tmpDir, '360p');
        const outDir804p = path.join(tmpDir, '804p');

        try {
            // 1. Create temporary directory scaffolding
            // Ensure scratch folders exist structurally
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            if (!fs.existsSync(outDir360p)) fs.mkdirSync(outDir360p, { recursive: true });
            if (!fs.existsSync(outDir804p)) fs.mkdirSync(outDir804p, { recursive: true });

            // 2. Stream the input file from R2 straight onto local temp storage disk
            this.logger.log(`Downloading mezzanine source track to worker disk memory...`);
            const masterStream = await this.r2.getObjectStream(mezzanineKey);

            // Verify headers or handle empty stream bounds early
            if (!masterStream) {
                throw new Error(`Cloud asset retrieval failed: Received an unreadable object stream reference for ${mezzanineKey}`);
            }

            const inputWriteStream = fs.createWriteStream(localInputPath);

            
            await new Promise<void>((resolve, reject) => {
                let bytesReceived = 0;
                let isSettled = false; // Guard to prevent multi-resolving/rejecting

                const safeReject = (error: Error) => {
                    if (isSettled) return;
                    isSettled = true;
                    inputWriteStream.destroy(); // Prevent file locks / memory leaks
                    reject(error);
                };

                const safeResolve = () => {
                    if (isSettled) return;
                    isSettled = true;
                    resolve();
                };

                masterStream.on('data', (chunk) => {
                    bytesReceived += chunk.length;
                });

                masterStream.on('error', (error) => {
                    safeReject(new Error(`R2 Stream Download Failure: ${error.message}`));
                });

                // Handle the pipeline itself to intercept unpipe or core failures
                inputWriteStream.on('error', (error) => {
                    safeReject(new Error(`Local File Write Storage Failure: ${error.message}`));
                });

                // Rely EXCLUSIVELY on 'close' as the definitive end-of-lifecycle token
                inputWriteStream.on('close', () => {
                    if (bytesReceived === 0) {
                        return safeReject(new Error(`Zero bytes written to disk. Cloud file is not fully propagated yet.`));
                    }
                    this.logger.log(`Mezzanine file handle successfully flushed and closed on disk for movie: ${movieId}`);
                    safeResolve();
                });

                // Bind error handling directly to the pipe sequence
                masterStream.pipe(inputWriteStream);
            });

            // DEFENSIVE WORKER GATE: Pre-flight explicit confirmation validation
            if (!fs.existsSync(localInputPath)) {
                throw new Error(`Media Engine Panic: Target input track missing on local directory layer.`);
            }

            const stats = fs.statSync(localInputPath);
            if (stats.size === 0) {
                throw new Error(`Media Engine Panic: Target file size resolved to 0 bytes. Stream truncated.`);
            }

            this.logger.debug(`File integration verified successfully (${(stats.size / (1024 * 1024)).toFixed(2)} MB). Launching FFmpeg multi-variant ladder...`);
            
            // 3. Kickoff full multi-variant HLS multi-bitrate compilation directly via local paths
            // This bypasses the single output stream limitation entirely
            const ffmpegCommand = ffmpeg(localInputPath)
                // Universal optimization flags for random access alignment
                .inputOptions(['-re'])

                // --- Rendition 1: 360p ---
                .output(path.join(outDir360p, 'index.m3u8'))
                .outputOptions([
                    '-c:v libx264',
                    '-b:v 800k',
                    '-maxrate 856k',
                    '-bufsize 1200k',
                    '-s 640x360',
                    '-c:a aac',
                    '-b:a 96k',
                    '-g 48',                  // Strict IDR keyframe boundaries every 48 frames (2 seconds at 24fps)
                    '-keyint_min 48',
                    '-sc_threshold 0',         // Prevents scene changes from corrupting chunk time synchronization
                    '-f hls',
                    '-hls_time 4',             // Target 4-second chunk intervals matching blueprint spec
                    '-hls_playlist_type vod',
                    '-hls_segment_type fmp4',  // FORCES CMAF FRAGMENTED MP4 CONTAINER WRITING (.m4s)
                    '-hls_fmp4_init_filename', // Explicitly bundle the initialization map file inside the 360p subdirectory!
                    path.join(outDir360p, 'init.mp4'),
                    `-hls_segment_filename ${path.join(outDir360p, 'chunk_%03d.m4s')}`
                ])
                // Output Variant 2: 804p High-Bitrate Master Branch
                .output(path.join(outDir804p, 'index.m3u8'))
                .outputOptions([
                    '-c:v libx264',
                    '-b:v 4500k',
                    '-maxrate 4815k',
                    '-bufsize 7000k',
                    '-s 1430x804',
                    '-c:a aac',
                    '-b:a 128k',
                    '-g 48',
                    '-keyint_min 48',
                    '-sc_threshold 0',
                    '-f hls',
                    '-hls_time 4',
                    '-hls_playlist_type vod',
                    '-hls_segment_type fmp4',  // FORCES CMAF FRAGMENTED MP4 CONTAINER WRITING (.m4s)
                    '-hls_fmp4_init_filename',
                    path.join(outDir804p, 'init.mp4'),
                    `-hls_segment_filename ${path.join(outDir804p, 'chunk_%03d.m4s')}`
                ]);

            this.logger.log(`Spawning multi-variant local transcoding context for Movie ID: ${movieId}`);
            await this.runFfmpegAsPromise(ffmpegCommand);
            this.logger.log(`Encoding processing completed for Movie ID: ${movieId}. Packaging HLS structure uploads...`);

            // 4. Generate the master manifest topology structure textually
            const masterManifestContent = 
                `#EXTM3U\n` +
                `#EXT-X-VERSION:3\n` +
                `#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n` +
                `360p/index.m3u8\n` +
                `#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1430x804\n` +
                `804p/index.m3u8\n`;
            
            const masterManifestPath = path.join(tmpDir, 'master.m3u8');
            fs.writeFileSync(masterManifestPath, masterManifestContent, 'utf-8');

            // 5. Gather and upload all assets (skipping initial source file raw mezzanine copy)
            const getFileRecursively = (dir: string): string[] => {
                let results: string[] = [];
                const list = fs.readdirSync(dir);
                list.forEach((file) => {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat && stat.isDirectory()) {
                        results = results.concat(getFileRecursively(filePath));
                    } else {
                        results.push(filePath);
                    }
                });

                return results;
            }

            const allGeneratedFiles = getFileRecursively(tmpDir);
            this.logger.log(`Discovered ${allGeneratedFiles.length} streaming artifacts to upload to R2...`);

            // 6. STREAM REPLICATED ARTIFACTS DIRECTLY TO R2 BUCKET TARGET CORES
            for (const localFilePath of allGeneratedFiles) {
                // Determine the nested relative path structure (e.g. "360p/index.m3u8" or "master.m3u8")
                const relativePath = path.relative(tmpDir, localFilePath).replace(/\\/g, '/');
                const destinationR2Key = `film/${movieId}/${relativePath}`;

                // Establish high-fidelity Mime-Type for HLS streaming components
                let contentType = 'application/octet-stream';
                if (localFilePath.endsWith('.m3u8')) contentType = 'application/x-mpegURL';
                if (localFilePath.endsWith('.ts')) contentType = 'video/mp2t';
                if (localFilePath.endsWith('.m4s')) contentType = 'video/iso.segment';
                if (localFilePath.endsWith('.mpd')) contentType = 'application/dash+xml';
                if (localFilePath.endsWith('.mp4')) contentType = 'video/mp4';

                // Skip uploading the original raw mezzanine file if it got caught in the temp workspace pathing
                if (localFilePath.endsWith('mezzanine.mp4')) {
                    continue;
                }

                let uploadBody: Readable;

                if (localFilePath.endsWith('.m3u8')) {
                    // Read the manifest file into memory as text
                    let manifestContent = fs.readFileSync(localFilePath, 'utf-8');

                    // Force remove any "file:///D:/..." or "file:///D:\..." variants
                    // This matches 'file://' followed by an optional slash, 'D:', and any combinations of / or \
                    const fileUrlRegex = new RegExp(`file:\/\/\/?D:[\/\\\\][^\n\r]*?${movieId}[\/\\\\](360p|804p)[\/\\\\]`, 'g');
                    manifestContent = manifestContent.replace(fileUrlRegex, '');

                    // Catch any bare absolute paths like "D:\synchrostream_temp\transcode-xxx\804p\"
                    const absolutePathRegex = new RegExp(`D:[\/\\\\][^\n\r]*?${movieId}[\/\\\\](360p|804p)[\/\\\\]`, 'g');
                    manifestContent = manifestContent.replace(absolutePathRegex, '');

                    // Standardize backslashes for absolute directory text parsing
                    const standardizedTmpDir = tmpDir.replace(/\\/g, '/');

                    // 3. Ultimate safety catch-all: strip out any lingering explicit variant path strings entirely
                    manifestContent = manifestContent.split(`transcode-${movieId}/360p/`).join('');
                    manifestContent = manifestContent.split(`transcode-${movieId}\\360p\\`).join('');
                    manifestContent = manifestContent.split(`transcode-${movieId}/804p/`).join('');
                    manifestContent = manifestContent.split(`transcode-${movieId}\\804p\\`).join('');

                    uploadBody = Readable.from(manifestContent);
                } else {
                    // Media fragments (.m4s, init.mp4) can stream untouched
                    uploadBody = fs.createReadStream(localFilePath);
                }

                this.logger.debug(`Streaming artifact directly onto R2 target location: ${destinationR2Key} (${contentType})`);
                
                await this.r2.uploadStream({
                    key: destinationR2Key,
                    stream: uploadBody,
                    contentType: contentType,
                });
            }

            const finalManifestKey = `film/${movieId}/master.m3u8`;
            this.logger.log(`Asset bundle uploaded to cloud cluster. Registering root manifest mapping at key: ${finalManifestKey}`);

            // 7. STATE BOUNDARY SYNCHRONIZATION VIA POSTGRES MUTATION
            const assetSyncQuery = `
                UPDATE movies 
                SET 
                    hls_url = $1,
                    status = 'AVAILABLE'::processing_status,
                    is_cmaf_ready = true
                WHERE id = $2;
            `;

            await this.pg.query(assetSyncQuery, [finalManifestKey, movieId]);

            this.logger.log(`Movie ID: ${movieId} state is now officially registered as AVAILABLE.`);

            // Broadcast live data via WebSockets to alert the client UI dashboard context
            this.telemetryGateway.broadcastMovieStatusUpdate({ 
                movieId, 
                status: 'AVAILABLE', 
                hlsUrl: finalManifestKey 
            });
                
        } catch (error) {
            this.logger.error(`Processing error failed on Movie ID: ${movieId} execution loop: ${(error as Error).message}`);
            try {
                const failStatusQuery = `UPDATE movies SET status = 'FAILED'::processing_status WHERE id = $1;`;
                await this.pg.query(failStatusQuery, [movieId]);

                // FAILURE BROADCAST: Inform UI that transcoding hit a structural exception
                this.telemetryGateway.broadcastMovieStatusUpdate({ movieId, status: 'FAILED' });
            } catch (dbError) {
                this.logger.error(`Failed to flag transcoding failure for Movie ${movieId}: ${(dbError as Error).message}`);
            }
        } finally {
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                    this.logger.debug(`Cleaned up ephemeral disk transcode workspace for: ${movieId}`);
                }
            } catch (cleanupError) {
                this.logger.error(`Failed to clean up transcode directory ${tmpDir}: ${(cleanupError as Error).message}`);
            }
        }
    }
}