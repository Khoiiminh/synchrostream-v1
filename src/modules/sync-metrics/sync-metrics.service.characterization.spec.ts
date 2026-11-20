import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    BadRequestException,
    HttpException,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { SyncMetricsService } from "./sync-metrics.service.js";
import type { SyncMetricsBatchDto } from "./sync-metrics.dto.js";

/*
 * Characterization of the sync-metrics store (plan B5) on a real temporary
 * directory, before its pure rules move into domain/: NDJSON lines and
 * their enrichment, run metadata, listing, live reads with `since`, notes and
 * tags, deletion and runId validation.
 */

let root: string;
let now: number;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sync-metrics-"));
    now = Date.UTC(2026, 10, 20, 12);
    jest.spyOn(Date, "now").mockImplementation(() => now);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

function build() {
    const config = {
        get: (key: string) => (key === "SYNC_METRICS_DIR" ? root : undefined),
    } as ConfigService;
    return new SyncMetricsService(config);
}

function batch(
    overrides: Partial<SyncMetricsBatchDto> = {},
): SyncMetricsBatchDto {
    return {
        runId: "run-1",
        scenario: "wifi",
        roomId: "room-a",
        clientSessionId: "sess-1",
        records: [
            { kind: "drift", value: 12, participantId: "spoofed" },
            { kind: "drift", value: 7 },
        ],
        ...overrides,
    };
}

async function linesOf(file: string) {
    const raw = await readFile(join(root, "run-1", file), "utf8");
    return raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function expectHttp(
    promise: Promise<unknown>,
    type: new (...args: never[]) => HttpException,
    message: string,
) {
    const error: unknown = await promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(type);
    expect((error as HttpException).message).toBe(message);
}

describe("appendBatch", () => {
    it("writes one enriched line per record; identity comes from the request", async () => {
        const service = build();

        await expect(service.appendBatch("user/1", batch())).resolves.toEqual({
            accepted: 2,
        });

        // The user id is made filename-safe.
        expect(await readdir(join(root, "run-1"))).toEqual(
            expect.arrayContaining(["user_1__sess-1.ndjson", "_run.json"]),
        );
        expect(await linesOf("user_1__sess-1.ndjson")).toEqual([
            {
                kind: "drift",
                value: 12,
                participantId: "user/1",
                runId: "run-1",
                scenario: "wifi",
                roomId: "room-a",
                clientSessionId: "sess-1",
                serverReceivedAt: now,
            },
            {
                kind: "drift",
                value: 7,
                runId: "run-1",
                scenario: "wifi",
                roomId: "room-a",
                participantId: "user/1",
                clientSessionId: "sess-1",
                serverReceivedAt: now,
            },
        ]);
    });

    it("missing scenario and room are stored as null", async () => {
        const service = build();
        await service.appendBatch(
            "u1",
            batch({ scenario: undefined, roomId: undefined }),
        );
        const [first] = await linesOf("u1__sess-1.ndjson");
        expect(first).toMatchObject({ scenario: null, roomId: null });
    });

    it("client info goes first, as its own line", async () => {
        const service = build();
        await service.appendBatch(
            "u1",
            batch({
                client: { userAgent: "UA", kind: "spoofed" },
                records: [{ kind: "drift" }],
            }),
        );
        const lines = await linesOf("u1__sess-1.ndjson");
        expect(lines[0]).toEqual({
            kind: "spoofed",
            runId: "run-1",
            participantId: "u1",
            clientSessionId: "sess-1",
            serverReceivedAt: now,
            userAgent: "UA",
        });
        expect(lines).toHaveLength(2);
    });

    it("an empty batch writes no file but still updates the run", async () => {
        const service = build();
        await expect(
            service.appendBatch("u1", batch({ records: [] })),
        ).resolves.toEqual({ accepted: 0 });
        expect(await readdir(join(root, "run-1"))).toEqual(["_run.json"]);
    });

    it("accumulates run metadata without duplicates", async () => {
        const service = build();
        await service.appendBatch("u1", batch());
        now += 1_000;
        await service.appendBatch(
            "u2",
            batch({ scenario: "4g", clientSessionId: "sess-2" }),
        );
        await service.appendBatch("u1", batch({ records: [{ kind: "x" }] }));

        const meta = JSON.parse(
            await readFile(join(root, "run-1", "_run.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(meta).toEqual({
            runId: "run-1",
            createdAt: now - 1_000,
            lastRecordAt: now,
            recordCount: 5,
            scenarios: ["wifi", "4g"],
            roomIds: ["room-a"],
            participants: ["u1", "u2"],
            clientSessions: ["sess-1", "sess-2"],
            notes: "",
            tags: [],
        });
    });

    it("concurrent batches for one run all reach the metadata", async () => {
        const service = build();
        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                service.appendBatch(
                    `u${i}`,
                    batch({ records: [{ kind: "x" }] }),
                ),
            ),
        );
        const { meta } = await service.readRun("run-1");
        expect(meta.recordCount).toBe(8);
        expect(meta.participants).toHaveLength(8);
    });
});

describe("listRuns", () => {
    it("is empty when the folder does not exist", async () => {
        await rm(root, { recursive: true, force: true });
        await expect(build().listRuns()).resolves.toEqual([]);
    });

    it("summarizes runs newest first and ignores unsafe names and stray files", async () => {
        const service = build();
        await service.appendBatch("u1", batch({ runId: "older" }));
        now += 5_000;
        await service.appendBatch("u1", batch({ runId: "newer" }));
        await writeFile(join(root, "not a run!"), "x");
        await writeFile(join(root, "loose-file"), "x");

        const runs = await service.listRuns();

        expect(runs.map((r) => r.runId)).toEqual(["newer", "older"]);
        expect(runs[0]).toMatchObject({
            files: 1,
            recordCount: 2,
            lastRecordAt: now,
        });
        expect(runs[0].bytes).toBeGreaterThan(0);
    });

    it("a run without metadata falls back to its files' modification time", async () => {
        const service = build();
        await service.appendBatch("u1", batch());
        await rm(join(root, "run-1", "_run.json"));

        const [run] = await service.listRuns();
        expect(run.recordCount).toBe(0);
        expect(run.lastRecordAt).toBeGreaterThan(0);
        expect(run.createdAt).toBe(run.lastRecordAt);
    });
});

describe("readRun", () => {
    it("returns every record across sessions, skipping blank and torn lines", async () => {
        const service = build();
        await service.appendBatch("u1", batch());
        await service.appendBatch("u2", batch({ clientSessionId: "sess-2" }));
        await writeFile(
            join(root, "run-1", "u3__sess-3.ndjson"),
            '{"kind":"ok","serverReceivedAt":1}\n\n{"kind":"torn',
        );

        const result = await service.readRun("run-1");

        expect(result.records).toHaveLength(5);
        expect(result.serverTime).toBe(now);
        expect(result.meta.participants).toEqual(["u1", "u2"]);
    });

    it("with since, only records received strictly after it", async () => {
        const service = build();
        await service.appendBatch("u1", batch());
        const first = now;
        now += 10;
        await service.appendBatch("u1", batch({ records: [{ kind: "late" }] }));

        const { records } = await service.readRun("run-1", first);
        expect(records.map((r) => r.kind)).toEqual(["late"]);
    });

    it("an unknown run is 404 and an unsafe id is 400", async () => {
        await expectHttp(
            build().readRun("missing"),
            NotFoundException,
            "No metrics stored for run missing",
        );
        await expectHttp(
            build().readRun("../etc"),
            BadRequestException,
            "Invalid runId",
        );
    });
});

describe("updateRun and deleteRun", () => {
    it("sets notes and de-duplicated, trimmed, non-empty tags", async () => {
        const service = build();
        await service.appendBatch("u1", batch());

        const meta = await service.updateRun("run-1", {
            notes: "lab wifi",
            tags: [" a", "b", "a", "  ", "b "],
        });

        expect(meta).toMatchObject({ notes: "lab wifi", tags: ["a", "b"] });
        // Omitted fields are left as they are.
        await expect(service.updateRun("run-1", {})).resolves.toMatchObject({
            notes: "lab wifi",
            tags: ["a", "b"],
        });
    });

    it("unknown runs are 404 for update and delete", async () => {
        const service = build();
        await expectHttp(
            service.updateRun("nope", { notes: "x" }),
            NotFoundException,
            "No metrics stored for run nope",
        );
        await expectHttp(
            service.deleteRun("nope"),
            NotFoundException,
            "No metrics stored for run nope",
        );
    });

    it("deletes the whole run", async () => {
        const service = build();
        await service.appendBatch("u1", batch());

        await expect(service.deleteRun("run-1")).resolves.toEqual({
            deleted: "run-1",
        });
        expect(await readdir(root)).toEqual([]);
    });
});
