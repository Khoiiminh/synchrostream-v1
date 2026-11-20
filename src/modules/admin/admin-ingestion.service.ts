import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from "@nestjs/common";
import { INGESTION_SWEEP_INTERVAL_MS } from "./domain/ingestion.js";
import type {
    AdminTelemetryBroadcastPort,
    MovieCatalogPort,
    ObjectStoragePort,
    TranscodeQueuePort,
} from "./application/ports/collaborators.port.js";
import {
    ADMIN_TELEMETRY_BROADCAST,
    MOVIE_CATALOG,
    OBJECT_STORAGE,
    TRANSCODE_QUEUE_PORT,
} from "./application/ports/tokens.js";
import { UploadSessions } from "./application/use-cases/upload-sessions.js";
import {
    FinalizeUpload,
    InitiateUpload,
    UploadChunk,
} from "./application/use-cases/upload-movie.js";
import type { InitiateUploadDto } from "./presentation/dto/admin.dto.js";
import { withHttpErrors } from "./presentation/error-mapper.js";

/**
 * The upload facade used by AdminController: builds the use cases from the
 * ports, runs the stale-session sweep, aborts open uploads on shutdown, and
 * converts domain errors to the HTTP exceptions clients have always received.
 */
@Injectable()
export class AdminIngestionService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AdminIngestionService.name);
    private readonly sessions: UploadSessions;
    private readonly initiate: InitiateUpload;
    private readonly chunk: UploadChunk;
    private readonly finalize: FinalizeUpload;
    private cleanupInterval?: NodeJS.Timeout;

    constructor(
        @Inject(MOVIE_CATALOG) catalog: MovieCatalogPort,
        @Inject(OBJECT_STORAGE) storage: ObjectStoragePort,
        @Inject(TRANSCODE_QUEUE_PORT) queue: TranscodeQueuePort,
        @Inject(ADMIN_TELEMETRY_BROADCAST)
        broadcast: AdminTelemetryBroadcastPort,
    ) {
        this.sessions = new UploadSessions(storage, catalog, this.logger);
        this.initiate = new InitiateUpload(
            catalog,
            storage,
            this.sessions,
            this.logger,
        );
        this.chunk = new UploadChunk(storage, this.sessions, this.logger);
        this.finalize = new FinalizeUpload(
            storage,
            queue,
            broadcast,
            this.sessions,
            this.logger,
        );
    }

    onModuleInit() {
        this.logger.log({
            message: "Starting stale ingestion session sweeper",
        });

        this.cleanupInterval = setInterval(() => {
            this.sessions.sweepExpired(Date.now());
        }, INGESTION_SWEEP_INTERVAL_MS);
    }

    async onModuleDestroy() {
        this.logger.log({
            message: "Shutting down; aborting active ingestion sessions",
            count: this.sessions.size,
        });
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        await this.sessions.abortAll("Container Shutdown");
    }

    initiateMovieUpload(
        dto: InitiateUploadDto,
    ): Promise<{ movieId: string; uploadId: string; objectKey: string }> {
        return withHttpErrors(() => this.initiate.execute(dto));
    }

    processChunkIngestion(params: {
        movieId: string;
        uploadId: string;
        partNumber: number;
        fileBuffer: Buffer;
    }): Promise<{ etag: string }> {
        return withHttpErrors(() => this.chunk.execute(params));
    }

    finalizeMovieUpload(params: {
        movieId: string;
        uploadId: string;
        parts: Array<{ PartNumber: number; ETag: string }>;
    }): Promise<{ message: string; objectKey: string; movieId: string }> {
        return withHttpErrors(() => this.finalize.execute(params));
    }
}
