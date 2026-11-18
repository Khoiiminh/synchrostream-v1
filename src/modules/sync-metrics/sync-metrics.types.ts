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
