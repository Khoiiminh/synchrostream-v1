import type { Provider } from "@nestjs/common";
import { MovieCatalogWrites } from "../../../media/queries/movie-catalog-writes.js";
import { TranscodePipeline } from "./transcode-pipeline.js";
import { TranscodeTelemetryPublisher } from "./transcode-telemetry.publisher.js";
import { TranscodeJobProcessor } from "./transcode-job.processor.js";
import { TranscodeWorkerHost } from "./transcode-worker.host.js";
import type {
    MovieCatalogPort,
    TranscodeTelemetryPort,
    TranscoderPort,
} from "../../application/ports/collaborators.port.js";
import {
    MOVIE_CATALOG,
    TRANSCODE_TELEMETRY,
    TRANSCODER,
} from "../../application/ports/tokens.js";

type Implements<Port, Adapter extends Port> = Adapter;
export type WorkerAdapterChecks = [
    Implements<MovieCatalogPort, MovieCatalogWrites>,
    Implements<TranscodeTelemetryPort, TranscodeTelemetryPublisher>,
    Implements<TranscoderPort, TranscodePipeline>,
];

/**
 * Worker process only (WorkerModule): runs transcode jobs with ffmpeg.
 * MovieCatalogWrites and R2 are provided by WorkerModule itself.
 */
export const ADMIN_WORKER_BINDINGS: Provider[] = [
    TranscodePipeline,
    TranscodeTelemetryPublisher,
    TranscodeJobProcessor,
    TranscodeWorkerHost,
    { provide: MOVIE_CATALOG, useExisting: MovieCatalogWrites },
    { provide: TRANSCODER, useExisting: TranscodePipeline },
    { provide: TRANSCODE_TELEMETRY, useExisting: TranscodeTelemetryPublisher },
];
