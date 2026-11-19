import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker, type Job } from "bullmq";
import { TranscodeJobProcessor } from "./transcode-job.processor.js";
import {
    TRANSCODE_QUEUE_NAME,
    bullConnection,
    type TranscodeJobData,
} from "./transcode-queue.contract.js";

/** Owns the BullMQ Worker in the worker process and feeds it to the processor. */
@Injectable()
export class TranscodeWorkerHost
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = new Logger(TranscodeWorkerHost.name);
    private worker?: Worker<TranscodeJobData, { hlsUrl: string }>;

    constructor(
        private readonly configService: ConfigService,
        private readonly processor: TranscodeJobProcessor,
    ) {}

    onApplicationBootstrap() {
        const concurrency = Math.max(
            1,
            Number(this.configService.get<string>("TRANSCODE_CONCURRENCY")) ||
                1,
        );

        this.worker = new Worker<TranscodeJobData, { hlsUrl: string }>(
            TRANSCODE_QUEUE_NAME,
            (job: Job<TranscodeJobData>) => this.processor.process(job),
            {
                connection: bullConnection(this.configService, {
                    forWorker: true,
                }),
                concurrency,
                // Longer idle block = fewer Redis commands while the queue is
                // empty (Upstash bills per command). Delayed jobs still wake it.
                drainDelay: 30,
            },
        );

        this.worker.on("failed", (job, err) => {
            void this.processor.onFailed(job, err);
        });
        this.worker.on("error", (err) =>
            this.logger.error({ message: "Transcode worker error", err }),
        );

        this.logger.log({
            message: "Transcode worker listening",
            queue: TRANSCODE_QUEUE_NAME,
            concurrency,
        });
    }

    /** Lets the running job finish (or stall-recover on another worker). */
    async onApplicationShutdown() {
        await this.worker?.close();
    }
}
