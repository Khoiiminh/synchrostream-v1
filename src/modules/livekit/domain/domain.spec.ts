import {
    canBeginEnding,
    isPastStartupWindow,
    mayHaveProviderRoom,
    PARTICIPANT_GRANTS,
    STARTUP_WINDOW_MS,
    type MediaSessionStatus,
} from "./media-session.js";
import { MediaConflict, MediaForbidden, MediaNotFound } from "./errors.js";

const ALL: MediaSessionStatus[] = [
    "CREATED",
    "STARTING",
    "ACTIVE",
    "ENDING",
    "ENDED",
];

describe("startup window", () => {
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);

    it("is 30 seconds", () => {
        expect(STARTUP_WINDOW_MS).toBe(30_000);
    });

    it("is still open one millisecond before 30 s and closed at 30 s", () => {
        expect(isPastStartupWindow(new Date(now - 29_999), now)).toBe(false);
        expect(isPastStartupWindow(new Date(now - 30_000), now)).toBe(true);
    });

    it("accepts ISO strings as stored by the outbox", () => {
        expect(
            isPastStartupWindow(new Date(now - 60_000).toISOString(), now),
        ).toBe(true);
    });
});

describe("status rules", () => {
    it("only a session that reached STARTING may have a provider room", () => {
        expect(ALL.filter(mayHaveProviderRoom)).toEqual([
            "STARTING",
            "ACTIVE",
            "ENDING",
        ]);
    });

    it("ENDING can begin from CREATED, STARTING and ACTIVE", () => {
        expect(ALL.filter(canBeginEnding)).toEqual([
            "CREATED",
            "STARTING",
            "ACTIVE",
        ]);
    });
});

it("member tokens are short-lived with full media rights", () => {
    expect(PARTICIPANT_GRANTS).toEqual({
        ttl: "10m",
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
    });
});

it("each error carries its kind and message", () => {
    expect(new MediaNotFound("a")).toMatchObject({
        kind: "NOT_FOUND",
        message: "a",
    });
    expect(new MediaConflict("b")).toMatchObject({
        kind: "CONFLICT",
        message: "b",
    });
    expect(new MediaForbidden("c")).toMatchObject({
        kind: "FORBIDDEN",
        message: "c",
    });
});
