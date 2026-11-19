// Must stay the first import: loads the env file before anything reads process.env.
import "./common/config/load-env.js";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { WorkerModule } from "./worker.module.js";
import { AppLogger } from "./common/logging/logger.js";

/**
 * Transcode worker entrypoint: a Nest application context (no HTTP listener)
 * that consumes the media-transcode BullMQ queue and runs ffmpeg, keeping that
 * CPU load out of the API process and its realtime gateways.
 */
async function bootstrap() {
    const app = await NestFactory.createApplicationContext(WorkerModule, {
        bufferLogs: true,
    });
    app.useLogger(new AppLogger());
    app.enableShutdownHooks();
    await app.init();
    new Logger("WorkerBootstrap").log({ message: "Transcode worker started" });
}
await bootstrap();
