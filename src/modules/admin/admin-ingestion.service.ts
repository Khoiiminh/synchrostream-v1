import { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InitiateUploadDto } from "./media-ingestion.dto.js";
import { AdminTranscodingService } from "./admin-transcoding.service.js";

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
        private readonly pg: PostgresProvider,
        private readonly r2: CloudflareR2Provider,
        private readonly transcoding: AdminTranscodingService
    ) {}

    onModuleInit() {
        this.logger.log({ message: 'Starting stale ingestion session sweeper' });

        this.cleanupInterval = setInterval(() => {
            this.evictExpiredSessions();
        }, 600000);
    }

    async onModuleDestroy() {
        this.logger.log({ message: 'Shutting down; aborting active ingestion sessions', count: this.activeSessions.size });
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        for (const [movieId, session] of this.activeSessions.entries()) {
            await this.safelyAbortR2Session({movieId, session, reason: "Container Shutdown"});
        }
        this.activeSessions.clear();
    }

    private async safelyAbortR2Session({movieId, session, reason}:{movieId: string, session: IngestionSession, reason: string}): Promise<void> {
        try {
            this.logger.warn({ message: 'Aborting orphaned multipart upload on R2', movieId, reason });
            await this.r2.abortMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId
            });

            const rollbackQuery = `
                UPDATE movies 
                SET status = 'FAILED'::processing_status 
                WHERE id = $1 AND status = 'PROCESSING'::processing_status;
            `;
            await this.pg.query(rollbackQuery, [movieId]);
        } catch (error) {
            this.logger.error({ message: 'Failed to clean up aborted upload assets', movieId, err: error });
        }
    }

    private async evictExpiredSessions(): Promise<void> {
        const now = Date.now();
        this.logger.debug({ message: 'Scanning ingestion sessions for stale uploads' });

        for (const [movieId, session] of this.activeSessions.entries()) {
            if (now - session.createdAt > this.SESSION_TTL_MS) {
                this.logger.warn({ message: 'Ingestion session timed out; aborting upload', movieId });
            
                // 1. Fire and forget R2 abort commands
                this.r2.abortMultiPartUpload({ key: session.objectKey, uploadId: session.uploadId })
                    .catch(err => this.logger.error({ message: 'Failed to abort timed-out upload on R2', movieId, err }));

                // 2. Mark the DB entry accurate as FAILED
                this.markIngestionAsFailed(movieId);

                // 3. Clear memory map
                this.activeSessions.delete(movieId);
            }
        }
    }

    async markIngestionAsFailed(movieId: string): Promise<void> {
        const queryStr = `
            UPDATE movies 
            SET status = 'FAILED'::processing_status 
            WHERE id = $1;
        `;
        try {
            await this.pg.query(queryStr, [movieId]);
            this.logger.warn({ message: 'Marked movie as FAILED after aborted ingestion', movieId });
        } catch (dbErr) {
            this.logger.error({ message: 'Failed to mark movie as FAILED after aborted ingestion', movieId, err: dbErr });
        }
    }

    async initiateMovieUpload(dto: InitiateUploadDto): Promise<{ movieId: string, uploadId: string, objectKey: string }> {
        const objectIdQuery = `SELECT uuid_generate_v4() AS id;`;
        const row = await this.pg.query<{ id: string }>(objectIdQuery);
        const movieId = row.rows[0].id;

        const objectKey = `raw-mezzanines/${movieId}.mp4`;

        try {
            this.logger.log({ message: 'Starting multipart upload on R2', objectKey });
            const uploadId = await this.r2.startMultiPartUpload(objectKey);

            const metadata = JSON.stringify({
                genre: dto.genre,
                description: dto.description
            });

            const insertQuery = `
                INSERT INTO movies (id, title, status, metadata, hls_url)
                VALUES ($1, $2, 'PROCESSING'::processing_status, $3::jsonb, NULL)
                RETURNING id;
            `;
            await this.pg.query(insertQuery, [movieId, dto.title, metadata]);

            this.activeSessions.set(movieId, {
                uploadId,
                objectKey,
                createdAt: Date.now()
            });

            return { movieId, uploadId, objectKey };
        } catch (error) {
            this.logger.error({ message: 'Failed to initialize multipart upload', err: error });
            throw new BadRequestException(`Initialization vector failure: ${(error as Error).message}`);
        }
    }

    async processChunkIngestion(params: { movieId: string; uploadId: string; partNumber: number; fileBuffer: Buffer }): Promise<{etag: string}> {
        this.logger.debug({ message: 'Uploading chunk', movieId: params.movieId, uploadId: params.uploadId, partNumber: params.partNumber, bytes: params.fileBuffer.length });

        const session = this.activeSessions.get(params.movieId);

        if (!session) {
            this.logger.warn({ message: 'Chunk rejected: ingestion session not found or expired', movieId: params.movieId });
            throw new NotFoundException(`Ingestion pipeline session has expired`);
        }
        if(session.uploadId !== params.uploadId) {
            this.logger.warn({ message: 'Chunk rejected: upload id mismatch', movieId: params.movieId, expectedUploadId: session.uploadId, uploadId: params.uploadId });
            throw new NotFoundException(`Ingestion session is mismatch`);
        }

        try {
            const etag = await this.r2.uploadPart({
                key: session.objectKey,
                uploadId: session.uploadId,
                partNumber: params.partNumber,
                body: params.fileBuffer
            });

            this.logger.debug({ message: 'Chunk uploaded', movieId: params.movieId, partNumber: params.partNumber, etag });

            return { etag };
        } catch (error) {
            this.logger.error({ message: 'Chunk upload failed', movieId: params.movieId, partNumber: params.partNumber, err: error });
            throw new BadRequestException(`Chunk ingestion failure on part ${params.partNumber}: ${(error as Error).message}`);
        }
    }

    async finalizeMovieUpload({ movieId, uploadId, parts }: {
        movieId: string, 
        uploadId: string, 
        parts: Array<{PartNumber: number, ETag: string}>
    }): Promise<{ message: string, objectKey: string, movieId: string}> {
        this.logger.log({ message: 'Finalizing multipart upload', movieId, uploadId, partCount: parts.length });

        const session = this.activeSessions.get(movieId);
 
        if (!session) {
            this.logger.warn({ message: 'Finalize rejected: ingestion session not found or expired', movieId });
            throw new NotFoundException(`Ingestion pipeline session has expired`);
        }
        if(session.uploadId !== uploadId) {
            this.logger.warn({ message: 'Finalize rejected: upload id mismatch', movieId, expectedUploadId: session.uploadId, uploadId });
            throw new NotFoundException(`Ingestion session is mismatch`);
        }
        
        try {
            const structuralParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

            await this.r2.completeMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId,
                parts: structuralParts
            });

            this.logger.log({ message: 'Multipart upload completed on R2', movieId, objectKey: session.objectKey });
            this.logger.log({ message: 'Triggering transcode after upload', movieId });

            setTimeout(() => {
                this.transcoding.initiateBackgroundTranscode(movieId)
                .catch((err) => {
                    this.logger.error({ message: 'Post-upload transcode trigger failed', movieId, err });
                });
            }, 2500);

            return {
                message: `Mezzanine master file successfully consolidated on storage bucket. Background multi-variant HLS encoding matrix initialized for Movie ID: ${movieId}.`,
                objectKey: session.objectKey,
                movieId: movieId
            }
        } catch (error) {
            this.logger.error({ message: 'Failed to complete multipart upload', movieId, err: error });
            throw new BadRequestException(`Multipart closure operation failed: ${(error as Error).message}`);
        } finally {
            this.logger.debug({ message: 'Removed ingestion session', movieId });
            this.activeSessions.delete(movieId);
        }
    }
}