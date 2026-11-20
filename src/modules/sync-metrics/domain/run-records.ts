/*
 * Synchronization measurements, grouped into runs (one experiment) and stored
 * as NDJSON lines, one file per participant session. These are the rules for
 * what a stored line and a run's metadata contain; the service does the I/O.
 */

/** Run, scenario and participant ids become path segments, so keep them filename-safe. */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** Name of the metadata file inside a run folder. */
export const META_FILE = "_run.json";

/** Per-run metadata kept next to the NDJSON files (`_run.json`). */
export interface SyncRunMeta {
    runId: string;
    createdAt: number;
    lastRecordAt: number;
    recordCount: number;
    scenarios: string[];
    roomIds: string[];
    participants: string[];
    clientSessions: string[];
    /** Free-text notes from the experimenter (what was done, conditions). */
    notes: string;
    tags: string[];
}

export interface SyncRunSummary extends SyncRunMeta {
    files: number;
    bytes: number;
}

/** One client's upload, as the store needs it. */
export interface MetricsBatch {
    runId: string;
    scenario?: string;
    roomId?: string;
    clientSessionId: string;
    client?: Record<string, unknown>;
    records: Record<string, unknown>[];
}

export function isSafeId(value: string): boolean {
    return SAFE_ID_PATTERN.test(value);
}

/** `<user>__<session>.ndjson`, with the user id made filename-safe. */
export function sessionFileName(
    userId: string,
    clientSessionId: string,
): string {
    const safeUser = userId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
    return `${safeUser}__${clientSessionId}.ndjson`;
}

/**
 * The NDJSON lines for a batch. Identity and grouping come from the
 * authenticated request, never from the record; client info, when present,
 * is the first line.
 */
export function storedLines(
    userId: string,
    batch: MetricsBatch,
    serverReceivedAt: number,
): string[] {
    const lines = batch.records.map((record) =>
        JSON.stringify({
            ...record,
            runId: batch.runId,
            scenario: batch.scenario ?? null,
            roomId: batch.roomId ?? null,
            participantId: userId,
            clientSessionId: batch.clientSessionId,
            serverReceivedAt,
        }),
    );

    if (batch.client) {
        lines.unshift(
            JSON.stringify({
                kind: "client_info",
                runId: batch.runId,
                participantId: userId,
                clientSessionId: batch.clientSessionId,
                serverReceivedAt,
                ...batch.client,
            }),
        );
    }
    return lines;
}

export function emptyRunMeta(runId: string): SyncRunMeta {
    return {
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
}

/** Stored metadata over the defaults; the folder name is the run id. */
export function restoreRunMeta(
    runId: string,
    stored: Partial<SyncRunMeta>,
): SyncRunMeta {
    return { ...emptyRunMeta(runId), ...stored, runId };
}

/** Records a batch in the run's metadata (in place). */
export function recordBatch(
    meta: SyncRunMeta,
    userId: string,
    batch: MetricsBatch,
    serverReceivedAt: number,
): void {
    meta.lastRecordAt = serverReceivedAt;
    meta.recordCount += batch.records.length;
    addUnique(meta.scenarios, batch.scenario);
    addUnique(meta.roomIds, batch.roomId);
    addUnique(meta.participants, userId);
    addUnique(meta.clientSessions, batch.clientSessionId);
}

/** Applies the experimenter's notes and tags (in place); omitted fields stay. */
export function annotateRun(
    meta: SyncRunMeta,
    update: { notes?: string; tags?: string[] },
): void {
    if (update.notes !== undefined) meta.notes = update.notes;
    if (update.tags !== undefined)
        meta.tags = [
            ...new Set(update.tags.map((t) => t.trim()).filter(Boolean)),
        ];
}

/**
 * The records in one NDJSON file. Blank lines and a torn final line (process
 * killed mid-write) are skipped; with `since`, only records received
 * strictly after it.
 */
export function parseRunLines(
    content: string,
    since?: number,
): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
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
            // torn line
        }
    }
    return records;
}

/** A run's listing entry; a run without metadata uses its files' mtime. */
export function summarizeRun(
    meta: SyncRunMeta,
    files: { count: number; bytes: number; lastModified: number },
): SyncRunSummary {
    return {
        ...meta,
        lastRecordAt: meta.lastRecordAt || files.lastModified,
        createdAt: meta.createdAt || files.lastModified,
        files: files.count,
        bytes: files.bytes,
    };
}

export function newestFirst(runs: SyncRunSummary[]): SyncRunSummary[] {
    return runs.sort((a, b) => b.lastRecordAt - a.lastRecordAt);
}

function addUnique(list: string[], value: string | undefined | null): void {
    if (value && !list.includes(value)) list.push(value);
}
