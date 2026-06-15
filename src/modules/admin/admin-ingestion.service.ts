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
        this.logger.log(`Initializing active session garbage collection routine...`);

        this.cleanupInterval = setInterval(() => {
            this.evictExpiredSessions();
        }, 600000);
    }

    async onModuleDestroy() {
        this.logger.warn(`Application environment termination detected. Evacuating all stateful ingestion actors...`);
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
            this.logger.warn(`Aborting orphaned multipart allocation on R2 storage for Movie ID: ${movieId}. Reason: ${reason}`);
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
            this.logger.error(`Failed to securely clean asset vectors for Movie ID ${movieId}: ${(error as Error).message}`);
        }
    }

    private async evictExpiredSessions(): Promise<void> {
        const now = Date.now();
        this.logger.log(`Scanning active video ingestion registries for stale session metrics...`);

        for (const [movieId, session] of this.activeSessions.entries()) {
            if (now - session.createdAt > this.SESSION_TTL_MS) {
                this.logger.warn(`Ingestion session timed out for Movie ID: ${movieId}. Aborting R2 state.`);
            
                // 1. Fire and forget R2 abort commands
                this.r2.abortMultiPartUpload({ key: session.objectKey, uploadId: session.uploadId })
                    .catch(err => this.logger.error(`R2 Abort error for ${movieId}:`, err));

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
            this.logger.warn(`Database lifecycle updated to FAILED for crashed asset entry: ${movieId}`);
        } catch (dbErr) {
            this.logger.error(`Failed to flip recovery status for ${movieId}:`, dbErr);
        }
    }

    async initiateMovieUpload(dto: InitiateUploadDto): Promise<{ movieId: string, uploadId: string, objectKey: string }> {
        const objectIdQuery = `SELECT uuid_generate_v4() AS id;`;
        const [row] = await this.pg.query<{ id: string }>(objectIdQuery);
        const movieId = row.id;

        const objectKey = `raw-mezzanines/${movieId}.mp4`;

        try {
            this.logger.log(`Opening multipart handshake protocol on R2 storage layer for object: ${objectKey}`);
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
            this.logger.error(`Critical transaction collapse during initialization of payload sequence: ${(error as Error).message}`);
            throw new BadRequestException(`Initialization vector failure: ${(error as Error).message}`);
        }
    }

    async processChunkIngestion(params: { movieId: string; uploadId: string; partNumber: number; fileBuffer: Buffer }): Promise<{etag: string}> {
        this.logger.log(`Processing chunk ingestion. Movie ID: ${params.movieId}, Upload ID: ${params.uploadId}, Part Number: ${params.partNumber}, Size: ${params.fileBuffer.length} bytes`);

        const session = this.activeSessions.get(params.movieId);

        if (!session) {
            this.logger.warn(`Ingestion pipeline session not found or expired for Movie ID: ${params.movieId}`);
            throw new NotFoundException(`Ingestion pipeline session has expired`);
        }
        if(session.uploadId !== params.uploadId) {
            this.logger.warn(`Ingestion session mismatch for Movie ID: ${params.movieId}. Expected Upload ID: ${session.uploadId}, Received: ${params.uploadId}`);
            throw new NotFoundException(`Ingestion session is mismatch`);
        }

        try {
            const etag = await this.r2.uploadPart({
                key: session.objectKey,
                uploadId: session.uploadId,
                partNumber: params.partNumber,
                body: params.fileBuffer
            });

            this.logger.log(`Successfully uploaded part ${params.partNumber} for Movie ID: ${params.movieId}. ETag: ${etag}`);

            return { etag };
        } catch (error) {
            this.logger.error(`Chunk ingestion transport layer failed at part sequence ${params.partNumber}: ${(error as Error).message}`);
            throw new BadRequestException(`Chunk ingestion failure on part ${params.partNumber}: ${(error as Error).message}`);
        }
    }

    async finalizeMovieUpload({ movieId, uploadId, parts }: {
        movieId: string, 
        uploadId: string, 
        parts: Array<{PartNumber: number, ETag: string}>
    }): Promise<{ message: string, objectKey: string, movieId: string}> {
        this.logger.log(`Finalizing movie upload. Movie ID: ${movieId}, Upload ID: ${uploadId}, Total Parts: ${parts.length}`);

        const session = this.activeSessions.get(movieId);
 
        if (!session) {
            this.logger.warn(`Ingestion pipeline session not found or expired during finalization. Movie ID: ${movieId}`);
            throw new NotFoundException(`Ingestion pipeline session has expired`);
        }
        if(session.uploadId !== uploadId) {
            this.logger.warn(`Ingestion session mismatch during finalization. Movie ID: ${movieId}. Expected: ${session.uploadId}, Received: ${uploadId}`);
            throw new NotFoundException(`Ingestion session is mismatch`);
        }
        
        try {
            const structuralParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

            await this.r2.completeMultiPartUpload({
                key: session.objectKey,
                uploadId: session.uploadId,
                parts: structuralParts
            });

            this.logger.log(`Multipart upload finalized successfully on R2. Movie ID: ${movieId}, Object Key: ${session.objectKey}\n`);
            this.logger.log(`Starting the transcoding engine for: ${movieId}`);

            setTimeout(() => {
                this.transcoding.initiateBackgroundTranscode(movieId)
                .catch((err) => {
                    this.logger.error(`Automated post-ingestion transcode trigger failed for movie ${movieId}: ${err.message}`);
                });
            }, 2500);

            return {
                message: `Mezzanine master file successfully consolidated on storage bucket. Background multi-variant HLS encoding matrix initialized for Movie ID: ${movieId}.`,
                objectKey: session.objectKey,
                movieId: movieId
            }
        } catch (error) {
            this.logger.error(`Multipart closure operation failed for Movie ID: ${movieId}. Error: ${(error as Error).message}`);
            throw new BadRequestException(`Multipart closure operation failed: ${(error as Error).message}`);
        } finally {
            this.logger.debug(`Cleaning up ingestion session from active sessions map for Movie ID: ${movieId}`);
            this.activeSessions.delete(movieId);
        }
    }
}