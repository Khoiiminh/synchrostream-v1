import {
    INGESTION_SESSION_TTL_MS,
    INGESTION_SWEEP_INTERVAL_MS,
    isSessionExpired,
    mezzanineKeyFor,
    movieMetadataJson,
    orderParts,
} from "./ingestion.js";
import { isFinalAttempt, ProgressSteps } from "./transcode.js";
import { MESSAGES } from "./errors.js";

describe("ingestion rules", () => {
    it("sessions live 30 minutes and are swept every 10", () => {
        expect(INGESTION_SESSION_TTL_MS).toBe(30 * 60_000);
        expect(INGESTION_SWEEP_INTERVAL_MS).toBe(10 * 60_000);
    });

    it("a session expires only when strictly older than the TTL", () => {
        const session = { uploadId: "u", objectKey: "k", createdAt: 1_000 };
        expect(
            isSessionExpired(session, 1_000 + INGESTION_SESSION_TTL_MS),
        ).toBe(false);
        expect(
            isSessionExpired(session, 1_001 + INGESTION_SESSION_TTL_MS),
        ).toBe(true);
    });

    it("raw uploads live under raw-mezzanines/", () => {
        expect(mezzanineKeyFor("m1")).toBe("raw-mezzanines/m1.mp4");
    });

    it("parts are ordered by part number", () => {
        expect(
            orderParts([
                { PartNumber: 3, ETag: "c" },
                { PartNumber: 1, ETag: "a" },
                { PartNumber: 2, ETag: "b" },
            ]).map((p) => p.ETag),
        ).toEqual(["a", "b", "c"]);
    });

    it("metadata keeps genre and description only", () => {
        expect(
            movieMetadataJson({
                genre: "G",
                description: "D",
                title: "ignored",
            } as never),
        ).toBe('{"genre":"G","description":"D"}');
    });

    it("error messages carry the cause", () => {
        expect(MESSAGES.chunkFailed(4, new Error("x"))).toBe(
            "Chunk ingestion failure on part 4: x",
        );
    });
});

describe("transcode rules", () => {
    it("an attempt is final when unrecoverable or out of attempts", () => {
        expect(isFinalAttempt(1, 3, false)).toBe(false);
        expect(isFinalAttempt(3, 3, false)).toBe(true);
        expect(isFinalAttempt(0, 3, true)).toBe(true);
    });

    it("progress is reported in whole, clamped, non-repeating steps", () => {
        const steps = new ProgressSteps();
        expect(steps.next("ENCODING", 10.2)).toBe(10);
        expect(steps.next("ENCODING", 10.9)).toBeNull();
        expect(steps.next("UPLOADING", 10.9)).toBe(10);
        expect(steps.next("UPLOADING", 140)).toBe(100);
        expect(steps.next("UPLOADING", 100)).toBeNull();
        expect(steps.next("UPLOADING", -5)).toBe(0);
    });
});
