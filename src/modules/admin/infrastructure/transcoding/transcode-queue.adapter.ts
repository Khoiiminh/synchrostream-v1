import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    type Provider,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import {
    TRANSCODE_QUEUE_NAME,
    bullConnection,
    TRANSCODE_JOB_NAME,
    TRANSCODE_QUEUE,
    mezzanineKeyFor,
    transcodeJobOptions,
    transcodeMaxAttempts,
    type TranscodeQueue,
} from "./transcode-queue.contract.js";
import type { TranscodeQueuePort } from "../../application/ports/collaborators.port.js";

/**
 * API side of transcoding: only enqueues. The ffmpeg work runs in the
 * separate worker process (src/worker.ts), so it cannot starve the realtime
 * gateways of CPU.
 */
@Injectable()
export class AdminTranscodingService
    implements TranscodeQueuePort, OnModuleDestroy
{
    private readonly logger = new Logger(AdminTranscodingService.name);
    private readonly maxAttempts: number;

    constructor(
        @Inject(TRANSCODE_QUEUE) private readonly queue: TranscodeQueue,
        configService: ConfigService,
    ) {
        this.maxAttempts = transcodeMaxAttempts(configService);
    }

    async enqueueTranscode(movieId: string): Promise<void> {
        await this.queue.add(
            TRANSCODE_JOB_NAME,
            { movieId, mezzanineKey: mezzanineKeyFor(movieId) },
            transcodeJobOptions(movieId, this.maxAttempts),
        );
        this.logger.log({ message: "Transcode job enqueued", movieId });
    }

    async onModuleDestroy() {
        await this.queue.close();
    }
}

/** The BullMQ producer. Producer only: the ffmpeg work runs in the worker process. */
export const TRANSCODE_QUEUE_PROVIDER: Provider = {
    provide: TRANSCODE_QUEUE,
    inject: [ConfigService],
    useFactory: (config: ConfigService): TranscodeQueue =>
        new Queue(TRANSCODE_QUEUE_NAME, {
            connection: bullConnection(config, { forWorker: false }),
        }),
};
