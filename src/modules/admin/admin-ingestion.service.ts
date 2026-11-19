import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { InitiateUploadDto } from "./admin.dto.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";
import { AdminRepository } from "./admin.repository.js";
import { MediaTelemetryGateway } from "./admin-media-telemetry.gateway.js";

interface IngestionSession {
    uploadId: string;
    objectKey: string;
    createdAt: number;
}

@Injectable()
export class AdminIngestionService implements OnModuleInit, OnModuleDestroy {
    private readonly activeSessions = new Map<string, IngestionSession>();
    private cleanupInterval!: NodeJS.Timeout;
    private readonly logger = new Logger(AdminIngestionService.name);
    private readonly SESSION_TTL_MS = 1800000;

    constructor(
        private readonly adminRepository: AdminRepository,
        private readonly r2: CloudflareR2Provider,
        private readonly transcoding: AdminTranscodingService,
        private readonly telemetryGateway: MediaTelemetryGateway,
    ) {}

    onModuleInit() {
        this.logger.log({
            message: "Starting stale ingestion session sweeper",
        });

        this.cleanupInterval = setInterval(() => {
            this.evictExpiredSessions();
        }, 600000);
    }

    async onModuleDestroy() {
        this.logger.log({
            message: "Shutting down; aborting active ingestion sessions",
            count: this.activeSessions.size,
        });
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        for (const [movieId, session] of this.activeSessions.entries()) {
            await this.safelyAbortR2Session({
                movieId,
                session,
                reason: "Container Shutdown",
            });
        }
        this.activeSessions.clear();
    }

    private async safelyAbortR2Session({
        movieId,
        session,
        reason,
    }: {
        movieId: string;
        session: IngestionSession;
        reason: string;
    }): Promise<void> {
        try {
            this.logger.warn({
                message: "Aborting orphaned multipart upload on R2",
                movieId,
                reason,
            });
            await this.r2.abortMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId,
            });

            await this.adminRepository.markFailedIfProcessing(movieId);
        } catch (error) {
            this.logger.error({
                message: "Failed to clean up aborted upload assets",
                movieId,
                err: error,
            });
        }
    }

    private evictExpiredSessions(): void {
        const now = Date.now();
        this.logger.debug({
            message: "Scanning ingestion sessions for stale uploads",
        });

        for (const [movieId, session] of this.activeSessions.entries()) {
            if (now - session.createdAt > this.SESSION_TTL_MS) {
                this.logger.warn({
                    message: "Ingestion session timed out; aborting upload",
                    movieId,
                });

                // 1. Fire and forget R2 abort commands
                this.r2
                    .abortMultiPartUpload({
                        key: session.objectKey,
                        uploadId: session.uploadId,
                    })
                    .catch((err: unknown) =>
                        this.logger.error({
                            message: "Failed to abort timed-out upload on R2",
                            movieId,
                            err,
                        }),
                    );

                // 2. Mark the DB entry accurate as FAILED
                void this.markIngestionAsFailed(movieId);

                // 3. Clear memory map
                this.activeSessions.delete(movieId);
            }
        }
    }

    async markIngestionAsFailed(movieId: string): Promise<void> {
        try {
            await this.adminRepository.markFailed(movieId);
            this.logger.warn({
                message: "Marked movie as FAILED after aborted ingestion",
                movieId,
            });
        } catch (dbErr) {
            this.logger.error({
                message:
                    "Failed to mark movie as FAILED after aborted ingestion",
                movieId,
                err: dbErr,
            });
        }
    }

    /**
     * The upload itself succeeded, so a queue outage must not turn the
     * response into an error (the old in-process trigger was fire-and-forget
     * too). Instead the movie is marked FAILED and the admin UI is told.
     */
    private async enqueueTranscodeOrFail(movieId: string): Promise<void> {
        try {
            await this.transcoding.enqueueTranscode(movieId);
        } catch (err) {
            this.logger.error({
                message: "Post-upload transcode enqueue failed",
                movieId,
                err,
            });
            await this.markIngestionAsFailed(movieId);
            this.telemetryGateway.broadcastMovieStatusUpdate({
                movieId,
                status: "FAILED",
            });
        }
    }

    async initiateMovieUpload(
        dto: InitiateUploadDto,
    ): Promise<{ movieId: string; uploadId: string; objectKey: string }> {
        const movieId = await this.adminRepository.generateMovieId();

        const objectKey = `raw-mezzanines/${movieId}.mp4`;

        try {
            this.logger.log({
                message: "Starting multipart upload on R2",
                objectKey,
            });
            const uploadId = await this.r2.startMultiPartUpload(objectKey);

            const metadata = JSON.stringify({
                genre: dto.genre,
                description: dto.description,
            });

            await this.adminRepository.insertProcessingMovie(
                movieId,
                dto.title,
                metadata,
            );

            this.activeSessions.set(movieId, {
                uploadId,
                objectKey,
                createdAt: Date.now(),
            });

            return { movieId, uploadId, objectKey };
        } catch (error) {
            this.logger.error({
                message: "Failed to initialize multipart upload",
                err: error,
            });
            throw new BadRequestException(
                `Initialization vector failure: ${(error as Error).message}`,
            );
        }
    }

    async processChunkIngestion(params: {
        movieId: string;
        uploadId: string;
        partNumber: number;
        fileBuffer: Buffer;
    }): Promise<{ etag: string }> {
        this.logger.debug({
            message: "Uploading chunk",
            movieId: params.movieId,
            uploadId: params.uploadId,
            partNumber: params.partNumber,
            bytes: params.fileBuffer.length,
        });

        const session = this.activeSessions.get(params.movieId);

        if (!session) {
            this.logger.warn({
                message:
                    "Chunk rejected: ingestion session not found or expired",
                movieId: params.movieId,
            });
            throw new NotFoundException(
                `Ingestion pipeline session has expired`,
            );
        }
        if (session.uploadId !== params.uploadId) {
            this.logger.warn({
                message: "Chunk rejected: upload id mismatch",
                movieId: params.movieId,
                expectedUploadId: session.uploadId,
                uploadId: params.uploadId,
            });
            throw new NotFoundException(`Ingestion session is mismatch`);
        }

        try {
            const etag = await this.r2.uploadPart({
                key: session.objectKey,
                uploadId: session.uploadId,
                partNumber: params.partNumber,
                body: params.fileBuffer,
            });

            this.logger.debug({
                message: "Chunk uploaded",
                movieId: params.movieId,
                partNumber: params.partNumber,
                etag,
            });

            return { etag };
        } catch (error) {
            this.logger.error({
                message: "Chunk upload failed",
                movieId: params.movieId,
                partNumber: params.partNumber,
                err: error,
            });
            throw new BadRequestException(
                `Chunk ingestion failure on part ${params.partNumber}: ${(error as Error).message}`,
            );
        }
    }

    async finalizeMovieUpload({
        movieId,
        uploadId,
        parts,
    }: {
        movieId: string;
        uploadId: string;
        parts: Array<{ PartNumber: number; ETag: string }>;
    }): Promise<{ message: string; objectKey: string; movieId: string }> {
        this.logger.log({
            message: "Finalizing multipart upload",
            movieId,
            uploadId,
            partCount: parts.length,
        });

        const session = this.activeSessions.get(movieId);

        if (!session) {
            this.logger.warn({
                message:
                    "Finalize rejected: ingestion session not found or expired",
                movieId,
            });
            throw new NotFoundException(
                `Ingestion pipeline session has expired`,
            );
        }
        if (session.uploadId !== uploadId) {
            this.logger.warn({
                message: "Finalize rejected: upload id mismatch",
                movieId,
                expectedUploadId: session.uploadId,
                uploadId,
            });
            throw new NotFoundException(`Ingestion session is mismatch`);
        }

        try {
            const structuralParts = parts.sort(
                (a, b) => a.PartNumber - b.PartNumber,
            );

            await this.r2.completeMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId,
                parts: structuralParts,
            });

            this.logger.log({
                message: "Multipart upload completed on R2",
                movieId,
                objectKey: session.objectKey,
            });
            await this.enqueueTranscodeOrFail(movieId);

            return {
                message: `Mezzanine master file successfully consolidated on storage bucket. Background multi-variant HLS encoding matrix initialized for Movie ID: ${movieId}.`,
                objectKey: session.objectKey,
                movieId: movieId,
            };
        } catch (error) {
            this.logger.error({
                message: "Failed to complete multipart upload",
                movieId,
                err: error,
            });
            throw new BadRequestException(
                `Multipart closure operation failed: ${(error as Error).message}`,
            );
        } finally {
            this.logger.debug({
                message: "Removed ingestion session",
                movieId,
            });
            this.activeSessions.delete(movieId);
        }
    }
}
