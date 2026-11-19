import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    ROOM_LIFECYCLE_STATUSES,
    acceptsParticipants,
    canTransition,
    isLiveRoom,
    isShuttingDown,
    reservesRoomCode,
} from "./room.js";
import {
    ROOM_CODE_ALPHABET,
    ROOM_CODE_GENERATION_ATTEMPTS,
    generateRoomCode,
    normalizeRoomCode,
    shouldRetryRoomCode,
} from "./room-code.js";
import {
    ROOM_PASSWORD_MAX_LENGTH,
    ROOM_PASSWORD_MIN_LENGTH,
    assertUsableRoomPassword,
    isBlankPassword,
    isUsableRoomPassword,
} from "./room-password.js";
import {
    assertJoinIdentity,
    assertJoinPasswordPresent,
    assertRoomHasCapacity,
    assertRoomJoinable,
    hasCapacity,
    isJoinPasswordRequired,
} from "./membership.js";
import { applyPlaybackCommand, initialPlaybackState } from "./playback.js";
import {
    InvalidJoinIdentity,
    PlaybackNotPermitted,
    RoomFull,
    RoomNotFound,
    RoomPasswordPolicyViolation,
    RoomPasswordRequired,
    RoomStillProvisioning,
    WatchPartyDomainError,
} from "./errors.js";

describe("domain/room lifecycle", () => {
    it.each([
        ["PROVISIONING", "ACTIVE", true],
        ["PROVISIONING", "TERMINATING", true],
        ["ACTIVE", "TERMINATING", true],
        ["TERMINATING", "TERMINATED", true],
        ["PROVISIONING", "TERMINATED", false],
        ["ACTIVE", "PROVISIONING", false],
        ["ACTIVE", "TERMINATED", false],
        ["TERMINATING", "ACTIVE", false],
        ["TERMINATED", "ACTIVE", false],
        ["TERMINATED", "PROVISIONING", false],
    ] as const)("%s → %s allowed: %s", (from, to, allowed) => {
        expect(canTransition(from, to)).toBe(allowed);
    });

    it("TERMINATED is final", () => {
        for (const to of ROOM_LIFECYCLE_STATUSES) {
            expect(canTransition("TERMINATED", to)).toBe(false);
        }
    });

    it.each([
        ["PROVISIONING", { live: true, accepts: false, shuttingDown: false, reservesCode: true }],
        ["ACTIVE", { live: true, accepts: true, shuttingDown: false, reservesCode: true }],
        ["TERMINATING", { live: false, accepts: false, shuttingDown: true, reservesCode: true }],
        ["TERMINATED", { live: false, accepts: false, shuttingDown: true, reservesCode: false }],
    ])("%s predicates", (status, expected) => {
        expect({
            live: isLiveRoom(status),
            accepts: acceptsParticipants(status),
            shuttingDown: isShuttingDown(status),
            reservesCode: reservesRoomCode(status),
        }).toEqual(expected);
    });
});

describe("domain/room-code", () => {
    it("normalizes by trimming and upper-casing", () => {
        expect(normalizeRoomCode("  ab12cd ")).toBe("AB12CD");
    });

    it("generates 6 characters from the alphabet", () => {
        const picks = [0, 25, 26, 35, 1, 2];
        let call = 0;
        expect(generateRoomCode(() => picks[call++])).toBe("AZ09BC");
        expect(generateRoomCode()).toMatch(
            new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`),
        );
    });

    it("never retries a requested code", () => {
        expect(shouldRetryRoomCode({ requestedCode: "ABC123", attempt: 0 })).toBe(false);
    });

    it("retries a generated code until the attempts run out", () => {
        const retries = Array.from(
            { length: ROOM_CODE_GENERATION_ATTEMPTS },
            (_, attempt) => shouldRetryRoomCode({ requestedCode: undefined, attempt }),
        );
        expect(retries).toEqual([true, true, true, true, false]);
    });
});

describe("domain/room-password", () => {
    it.each([
        ["abcd", true],
        ["  abcd  ", true],
        ["x".repeat(ROOM_PASSWORD_MAX_LENGTH), true],
        ["abc", false],
        ["   abc   ", false],
        ["      ", false],
        ["x".repeat(ROOM_PASSWORD_MAX_LENGTH + 1), false],
        [undefined, false],
        [1234, false],
    ])("isUsableRoomPassword(%p) = %s", (value, usable) => {
        expect(isUsableRoomPassword(value)).toBe(usable);
    });

    it("assertUsableRoomPassword throws the policy error with the limits", () => {
        expect(() => assertUsableRoomPassword("abc")).toThrow(
            new RoomPasswordPolicyViolation(
                ROOM_PASSWORD_MIN_LENGTH,
                ROOM_PASSWORD_MAX_LENGTH,
            ),
        );
        expect(() => assertUsableRoomPassword("abcd")).not.toThrow();
    });

    it.each([
        ["", true],
        ["   ", true],
        [undefined, true],
        [null, true],
        [42, true],
        ["a", false],
    ])("isBlankPassword(%p) = %s", (value, blank) => {
        expect(isBlankPassword(value)).toBe(blank);
    });
});

describe("domain/membership", () => {
    it("accepts a UUID user id and rejects anything else", () => {
        expect(() =>
            assertJoinIdentity("22222222-2222-4222-8222-222222222222"),
        ).not.toThrow();
        expect(() => assertJoinIdentity("not-a-uuid")).toThrow(InvalidJoinIdentity);
        expect(() => assertJoinIdentity("")).toThrow(InvalidJoinIdentity);
    });

    it("PROVISIONING is checked before absence: 503 wins over 404", () => {
        expect(() => assertRoomJoinable({ lifecycle_status: "PROVISIONING" })).toThrow(
            RoomStillProvisioning,
        );
        expect(() => assertRoomJoinable(undefined)).toThrow(RoomNotFound);
        expect(() => assertRoomJoinable(null)).toThrow(RoomNotFound);
        expect(() => assertRoomJoinable({ lifecycle_status: "ACTIVE" })).not.toThrow();
    });

    it.each([
        [{ isOwner: false, hasActiveMembership: false }, true],
        [{ isOwner: true, hasActiveMembership: false }, false],
        [{ isOwner: false, hasActiveMembership: true }, false],
        [{ isOwner: true, hasActiveMembership: true }, false],
    ])("password required for %p: %s", (who, required) => {
        expect(isJoinPasswordRequired(who)).toBe(required);
    });

    it("a blank join password is RoomPasswordRequired", () => {
        expect(() => assertJoinPasswordPresent("  ")).toThrow(RoomPasswordRequired);
        expect(() => assertJoinPasswordPresent("pw")).not.toThrow();
    });

    it("capacity: below the cap admits, at the cap is RoomFull", () => {
        expect(hasCapacity({ activeCount: 4, capacity: 5 })).toBe(true);
        expect(hasCapacity({ activeCount: 5, capacity: 5 })).toBe(false);
        expect(() => assertRoomHasCapacity({ activeCount: 5, capacity: 5 })).toThrow(
            new RoomFull(5),
        );
    });
});

describe("domain/playback", () => {
    const owner = "owner";
    const at = (now: number) => ({ requestingId: owner, ownerId: owner, now });

    it("starts paused at 0", () => {
        expect(initialPlaybackState(7)).toEqual({
            playhead: 0,
            status: "PAUSED",
            lastUpdated: 7,
        });
    });

    it("PLAY, PAUSE and SEEK", () => {
        const playing = applyPlaybackCommand(initialPlaybackState(0), {
            ...at(1),
            action: "PLAY",
            targetPlayhead: 10,
        });
        expect(playing).toEqual({ playhead: 10, status: "PLAYING", lastUpdated: 1 });

        const seeked = applyPlaybackCommand(playing, {
            ...at(2),
            action: "SEEK",
            targetPlayhead: 50,
        });
        expect(seeked).toEqual({ playhead: 50, status: "PLAYING", lastUpdated: 2 });

        expect(
            applyPlaybackCommand(seeked, { ...at(3), action: "PAUSE", targetPlayhead: 51 }),
        ).toEqual({ playhead: 51, status: "PAUSED", lastUpdated: 3 });
    });

    it("rejects anyone but the owner and does not mutate the input", () => {
        const state = initialPlaybackState(0);
        expect(() =>
            applyPlaybackCommand(state, {
                requestingId: "member",
                ownerId: owner,
                action: "PLAY",
                targetPlayhead: 5,
                now: 1,
            }),
        ).toThrow(PlaybackNotPermitted);
        expect(state).toEqual(initialPlaybackState(0));
    });
});

describe("domain errors", () => {
    it("are WatchPartyDomainErrors named after their class", () => {
        const error = new RoomFull(3);
        expect(error).toBeInstanceOf(WatchPartyDomainError);
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("RoomFull");
        expect(error.kind).toBe("ROOM_FULL");
    });
});

describe("domain purity", () => {
    // Until the phase 5 lint rule exists, this keeps domain/ framework-free.
    // Every module specifier: `from "x"`, bare `import "x"`, dynamic `import("x")`, `require("x")`.
    const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

    const sources = readdirSync(__dirname).filter(
        (file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"),
    );

    it("has source files to check", () => {
        expect(sources.length).toBeGreaterThan(0);
    });

    it.each(sources)("%s imports no framework or infrastructure", (file) => {
        const text = readFileSync(join(__dirname, file), "utf8");
        // Only sibling domain files and Node built-ins: no @nestjs, pg,
        // ioredis, socket.io, bcrypt, validators or shared infrastructure.
        const outside = [...text.matchAll(SPECIFIER)]
            .map(([, specifier]) => specifier)
            .filter((s) => !s.startsWith("./") && !s.startsWith("node:"));
        expect(outside).toEqual([]);
    });
});
