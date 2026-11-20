import {
    annotateRun,
    emptyRunMeta,
    isSafeId,
    parseRunLines,
    recordBatch,
    restoreRunMeta,
    sessionFileName,
    storedLines,
    summarizeRun,
} from "./run-records.js";

describe("run-record rules", () => {
    it("ids are 1–80 filename-safe characters", () => {
        expect(isSafeId("run_1-a")).toBe(true);
        expect(isSafeId("x".repeat(80))).toBe(true);
        expect(isSafeId("x".repeat(81))).toBe(false);
        expect(isSafeId("")).toBe(false);
        expect(isSafeId("../etc")).toBe(false);
    });

    it("session files are named <safe user>__<session>.ndjson", () => {
        expect(sessionFileName("a/b c", "s1")).toBe("a_b_c__s1.ndjson");
        expect(sessionFileName("u".repeat(90), "s1")).toBe(
            `${"u".repeat(80)}__s1.ndjson`,
        );
    });

    it("a record's own identity fields are overwritten by the request's", () => {
        const [line] = storedLines(
            "real",
            {
                runId: "r",
                clientSessionId: "s",
                records: [{ participantId: "fake", runId: "fake", v: 1 }],
            },
            5,
        );
        expect(JSON.parse(line)).toEqual({
            participantId: "real",
            runId: "r",
            v: 1,
            scenario: null,
            roomId: null,
            clientSessionId: "s",
            serverReceivedAt: 5,
        });
    });

    it("stored metadata is merged over defaults, keeping the folder's run id", () => {
        expect(restoreRunMeta("r1", { runId: "other", notes: "n" })).toEqual({
            ...emptyRunMeta("r1"),
            notes: "n",
        });
    });

    it("a batch adds counts and unique, non-empty names", () => {
        const meta = emptyRunMeta("r");
        const batch = {
            runId: "r",
            scenario: "",
            roomId: "room",
            clientSessionId: "s",
            records: [{}, {}],
        };
        recordBatch(meta, "u", batch, 9);
        recordBatch(meta, "u", batch, 10);
        expect(meta).toMatchObject({
            lastRecordAt: 10,
            recordCount: 4,
            scenarios: [],
            roomIds: ["room"],
            participants: ["u"],
            clientSessions: ["s"],
        });
    });

    it("annotating trims and de-duplicates tags and leaves omitted fields", () => {
        const meta = { ...emptyRunMeta("r"), notes: "keep" };
        annotateRun(meta, { tags: [" a ", "a", "", "b"] });
        expect(meta).toMatchObject({ notes: "keep", tags: ["a", "b"] });
    });

    it("parsing skips blank and torn lines and filters strictly after since", () => {
        const content = [
            '{"serverReceivedAt":1,"k":"a"}',
            "",
            '{"serverReceivedAt":2,"k":"b"}',
            '{"serverReceivedAt":3,"k":"c"}',
            '{"serverRec',
        ].join("\n");
        expect(parseRunLines(content).map((r) => r.k)).toEqual(["a", "b", "c"]);
        expect(parseRunLines(content, 2).map((r) => r.k)).toEqual(["c"]);
    });

    it("a summary falls back to the files' mtime only when metadata has no times", () => {
        const files = { count: 2, bytes: 10, lastModified: 50 };
        expect(summarizeRun(emptyRunMeta("r"), files)).toMatchObject({
            createdAt: 50,
            lastRecordAt: 50,
            files: 2,
            bytes: 10,
        });
        expect(
            summarizeRun(
                { ...emptyRunMeta("r"), createdAt: 1, lastRecordAt: 2 },
                files,
            ),
        ).toMatchObject({ createdAt: 1, lastRecordAt: 2 });
    });
});
