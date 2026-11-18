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
import {
    SAFE_ID_PATTERN,
    SyncMetricsBatchDto,
    UpdateSyncRunDto,
} from "./sync-metrics.dto.js";
import type { SyncRunMeta, SyncRunSummary } from "./sync-metrics.types.js";

const META_FILE = "_run.json";

/**
 * Persists synchronization measurements as NDJSON, one file per client
 * session under `<SYNC_METRICS_DIR>/<runId>/`. Plain files keep the data easy
 * to archive alongside the thesis and to analyze offline.
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
        const lines = dto.records.map((record) =>
            JSON.stringify({
                ...record,
                // Identity and grouping come from the authenticated request, not the record.
                runId: dto.runId,
                scenario: dto.scenario ?? null,
                roomId: dto.roomId ?? null,
                participantId: userId,
                clientSessionId: dto.clientSessionId,
                serverReceivedAt,
            }),
        );

        if (dto.client) {
            lines.unshift(
                JSON.stringify({
                    kind: "client_info",
                    runId: dto.runId,
                    participantId: userId,
                    clientSessionId: dto.clientSessionId,
                    serverReceivedAt,
                    ...dto.client,
                }),
            );
        }

        if (lines.length > 0) {
            const file = join(
                runDir,
                `${this.safe(userId)}__${dto.clientSessionId}.ndjson`,
            );
            await appendFile(file, lines.join("\n") + "\n", "utf8");
        }

        await this.updateMeta(dto.runId, (meta) => {
            meta.lastRecordAt = serverReceivedAt;
            meta.recordCount += dto.records.length;
            addUnique(meta.scenarios, dto.scenario);
            addUnique(meta.roomIds, dto.roomId);
            addUnique(meta.participants, userId);
            addUnique(meta.clientSessions, dto.clientSessionId);
        });

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
            if (!SAFE_ID_PATTERN.test(runId)) continue;
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
            runs.push({
                ...meta,
                lastRecordAt: meta.lastRecordAt || lastModified,
                createdAt: meta.createdAt || lastModified,
                files: files.length,
                bytes,
            });
        }

        return runs.sort((a, b) => b.lastRecordAt - a.lastRecordAt);
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
            for (const line of content.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const record = JSON.parse(line) as Record<string, unknown>;
                    if (
                        since !== undefined &&
                        !(Number(record.serverReceivedAt) > since)
                    )
                        continue;
                    records.push(record);
                } catch {
                    // A torn final line (process killed mid-write) is skipped.
                }
            }
        }
        return { meta: await this.readMeta(runId), records, serverTime };
    }

    async updateRun(
        runId: string,
        dto: UpdateSyncRunDto,
    ): Promise<SyncRunMeta> {
        await this.assertRunExists(runId);
        return this.updateMeta(runId, (meta) => {
            if (dto.notes !== undefined) meta.notes = dto.notes;
            if (dto.tags !== undefined)
                meta.tags = [
                    ...new Set(dto.tags.map((t) => t.trim()).filter(Boolean)),
                ];
        });
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
        const empty: SyncRunMeta = {
            runId,
            createdAt: 0,
            lastRecordAt: 0,
            recordCount: 0,
            scenarios: [],
            roomIds: [],
            participants: [],
            clientSessions: [],
            notes: "",
            tags: [],
        };
        try {
            const raw = JSON.parse(
                await readFile(join(this.runDir(runId), META_FILE), "utf8"),
            ) as Partial<SyncRunMeta>;
            return { ...empty, ...raw, runId };
        } catch {
            return empty;
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
        if (!SAFE_ID_PATTERN.test(runId)) {
            throw new BadRequestException("Invalid runId");
        }
        return join(this.rootDir, runId);
    }

    private safe(value: string): string {
        return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    }
}

function addUnique(list: string[], value: string | undefined | null): void {
    if (value && !list.includes(value)) list.push(value);
}
