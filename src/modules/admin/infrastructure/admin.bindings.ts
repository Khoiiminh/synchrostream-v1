import type { Provider } from "@nestjs/common";
import { CloudflareR2Provider } from "@/shared/infrastructure/storage/cloudflare-r2.provider.js";
import { MovieCatalogWrites } from "../../media/queries/movie-catalog-writes.js";
import {
    AdminTranscodingService,
    TRANSCODE_QUEUE_PROVIDER,
} from "./transcoding/transcode-queue.adapter.js";
import type {
    MovieCatalogPort,
    ObjectStoragePort,
    TranscodeQueuePort,
} from "../application/ports/collaborators.port.js";
import {
    MOVIE_CATALOG,
    OBJECT_STORAGE,
    TRANSCODE_QUEUE_PORT,
} from "../application/ports/tokens.js";

/*
 * Port → adapter. The catalog (media) and R2 classes were not written against
 * these ports, so their fit is checked here at compile time.
 */
type Implements<Port, Adapter extends Port> = Adapter;
export type AdapterChecks = [
    Implements<MovieCatalogPort, MovieCatalogWrites>,
    Implements<ObjectStoragePort, CloudflareR2Provider>,
    Implements<TranscodeQueuePort, AdminTranscodingService>,
];

/**
 * API process: uploads and the enqueue side of transcoding. Must not reach
 * ffmpeg; the worker's bindings are in transcoding/worker.bindings.ts.
 */
export const ADMIN_API_BINDINGS: Provider[] = [
    TRANSCODE_QUEUE_PROVIDER,
    AdminTranscodingService,
    { provide: MOVIE_CATALOG, useExisting: MovieCatalogWrites },
    { provide: OBJECT_STORAGE, useExisting: CloudflareR2Provider },
    { provide: TRANSCODE_QUEUE_PORT, useExisting: AdminTranscodingService },
];
