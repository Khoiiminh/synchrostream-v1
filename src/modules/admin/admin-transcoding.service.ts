import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    TRANSCODE_JOB_NAME,
    TRANSCODE_QUEUE,
    mezzanineKeyFor,
    transcodeJobOptions,
    transcodeMaxAttempts,
    type TranscodeQueue,
} from "./transcoding/transcode-queue.contract.js";

/**
 * API side of transcoding: only enqueues. The ffmpeg work runs in the
 * separate worker process (src/worker.ts), so it cannot starve the realtime
 * gateways of CPU.
 */
@Injectable()
export class AdminTranscodingService implements OnModuleDestroy {
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
