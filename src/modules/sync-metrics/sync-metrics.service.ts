import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    appendFile,
    mkdir,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { SyncMetricsBatchDto, UpdateSyncRunDto } from "./sync-metrics.dto.js";
import {
    META_FILE,
    annotateRun,
    emptyRunMeta,
    isSafeId,
    newestFirst,
    parseRunLines,
    recordBatch,
    restoreRunMeta,
    sessionFileName,
    storedLines,
    summarizeRun,
    type SyncRunMeta,
    type SyncRunSummary,
} from "./domain/run-records.js";

/**
 * Persists synchronization measurements as NDJSON, one file per client
 * session under `<SYNC_METRICS_DIR>/<runId>/`. Plain files keep the data easy
 * to archive alongside the thesis and to analyze offline. What a line and a
 * run's metadata contain is in domain/run-records.ts; this class does the I/O.
 */
@Injectable()
export class SyncMetricsService {
    private readonly logger = new Logger(SyncMetricsService.name);
    private readonly rootDir: string;
    /** Serializes metadata read-modify-write per run. */
    private readonly metaLocks = new Map<string, Promise<unknown>>();

    constructor(config: ConfigService) {
        this.rootDir = resolve(
            config.get<string>("SYNC_METRICS_DIR") ?? "metrics-data",
        );
    }

    async appendBatch(
        userId: string,
        dto: SyncMetricsBatchDto,
    ): Promise<{ accepted: number }> {
        const runDir = this.runDir(dto.runId);
        await mkdir(runDir, { recursive: true });

        const serverReceivedAt = Date.now();
        const lines = storedLines(userId, dto, serverReceivedAt);

        if (lines.length > 0) {
            const file = join(
                runDir,
                sessionFileName(userId, dto.clientSessionId),
            );
            await appendFile(file, lines.join("\n") + "\n", "utf8");
        }

        await this.updateMeta(dto.runId, (meta) =>
            recordBatch(meta, userId, dto, serverReceivedAt),
        );

        this.logger.debug({
            message: "Sync metrics batch stored",
            runId: dto.runId,
            userId,
            records: dto.records.length,
        });

        return { accepted: dto.records.length };
    }

    async listRuns(): Promise<SyncRunSummary[]> {
        let entries: string[];
        try {
            entries = await readdir(this.rootDir);
        } catch {
            return [];
        }

        const runs: SyncRunSummary[] = [];
        for (const runId of entries) {
            if (!isSafeId(runId)) continue;
            const dir = join(this.rootDir, runId);
            if (!(await stat(dir)).isDirectory()) continue;

            let bytes = 0;
            let lastModified = 0;
            const files = (await readdir(dir)).filter((f) =>
                f.endsWith(".ndjson"),
            );
            for (const file of files) {
                const info = await stat(join(dir, file));
                bytes += info.size;
                lastModified = Math.max(lastModified, info.mtimeMs);
            }
            const meta = await this.readMeta(runId);
            runs.push(
                summarizeRun(meta, {
                    count: files.length,
                    bytes,
                    lastModified,
                }),
            );
        }

        return newestFirst(runs);
    }

    /**
     * Returns the records of a run across all participants. With `since`,
     * only records received after that server time (for live refresh).
     */
    async readRun(
        runId: string,
        since?: number,
    ): Promise<{
        meta: SyncRunMeta;
        records: Record<string, unknown>[];
        serverTime: number;
    }> {
        const dir = this.runDir(runId);
        const serverTime = Date.now();
        let files: string[];
        try {
            files = (await readdir(dir)).filter((f) => f.endsWith(".ndjson"));
        } catch {
            throw new NotFoundException(`No metrics stored for run ${runId}`);
        }

        const records: Record<string, unknown>[] = [];
        for (const file of files) {
            const content = await readFile(join(dir, file), "utf8");
            records.push(...parseRunLines(content, since));
        }
        return { meta: await this.readMeta(runId), records, serverTime };
    }

    async updateRun(
        runId: string,
        dto: UpdateSyncRunDto,
    ): Promise<SyncRunMeta> {
        await this.assertRunExists(runId);
        return this.updateMeta(runId, (meta) => annotateRun(meta, dto));
    }

    async deleteRun(runId: string): Promise<{ deleted: string }> {
        const dir = await this.assertRunExists(runId);
        await rm(dir, { recursive: true, force: true });
        this.logger.log({ message: "Sync metrics run deleted", runId });
        return { deleted: runId };
    }

    private async assertRunExists(runId: string): Promise<string> {
        const dir = this.runDir(runId);
        try {
            if ((await stat(dir)).isDirectory()) return dir;
        } catch {
            // fall through
        }
        throw new NotFoundException(`No metrics stored for run ${runId}`);
    }

    private async readMeta(runId: string): Promise<SyncRunMeta> {
        try {
            const raw = JSON.parse(
                await readFile(join(this.runDir(runId), META_FILE), "utf8"),
            ) as Partial<SyncRunMeta>;
            return restoreRunMeta(runId, raw);
        } catch {
            return emptyRunMeta(runId);
        }
    }

    private updateMeta(
        runId: string,
        mutate: (meta: SyncRunMeta) => void,
    ): Promise<SyncRunMeta> {
        const previous = this.metaLocks.get(runId) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const meta = await this.readMeta(runId);
                if (!meta.createdAt) meta.createdAt = Date.now();
                mutate(meta);
                await writeFile(
                    join(this.runDir(runId), META_FILE),
                    JSON.stringify(meta, null, 2),
                    "utf8",
                );
                return meta;
            });
        this.metaLocks.set(runId, next);
        void next
            .finally(() => {
                if (this.metaLocks.get(runId) === next)
                    this.metaLocks.delete(runId);
            })
            .catch(() => undefined);
        return next;
    }

    private runDir(runId: string): string {
        if (!isSafeId(runId)) {
            throw new BadRequestException("Invalid runId");
        }
        return join(this.rootDir, runId);
    }
}
