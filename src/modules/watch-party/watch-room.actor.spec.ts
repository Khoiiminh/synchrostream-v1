import { BadRequestException, Logger } from "@nestjs/common";
import { WatchRoomActor, type ParticipantNode } from "./watch-room.actor.js";

/*
 * Characterization tests (refactor plan, phase 0). They pin the actor's
 * current behaviour, including behaviour that may look questionable, so the
 * refactor can prove it changed nothing. Change a test only on purpose.
 */

const OWNER = "owner-1";

function makeActor(maxParticipants = 3, mediaSessionId: string | null = null) {
    return new WatchRoomActor(
        "room-1",
        "ABC123",
        OWNER,
        "movie-1",
        maxParticipants,
        mediaSessionId,
    );
}

function node(userId: string, extra: Partial<ParticipantNode> = {}) {
    return {
        participantId: `p-${userId}`,
        userId,
        username: `name-${userId}`,
        latencyScore: 0,
        ...extra,
    };
}

beforeAll(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    jest.useRealTimers();
});

describe("WatchRoomActor", () => {
    describe("initial state", () => {
        it("starts paused at 0 with no members", () => {
            jest.useFakeTimers({ now: 1_000 });
            const actor = makeActor(5);

            expect(actor.getSnapshot()).toEqual({
                roomId: "room-1",
                roomCode: "ABC123",
                ownerId: OWNER,
                movieId: "movie-1",
                mediaSessionId: null,
                playback: { playhead: 0, status: "PAUSED", lastUpdated: 1_000 },
                occupancy: { current: 0, max: 5 },
                members: [],
            });
        });

        it("exposes and replaces the media session id", () => {
            const actor = makeActor(3, "ms-1");
            expect(actor.mediaSessionId).toBe("ms-1");

            actor.setMediaSessionId("ms-2");
            expect(actor.mediaSessionId).toBe("ms-2");
            expect(actor.getSnapshot().mediaSessionId).toBe("ms-2");
        });
    });

    describe("participants", () => {
        it("registers members keyed by userId", () => {
            const actor = makeActor();
            actor.registerParticipant(node("u1"));
            actor.registerParticipant(node("u2"));

            expect(actor.getParticipantCount()).toBe(2);
            expect(actor.getSnapshot().members.map((m) => m.userId)).toEqual([
                "u1",
                "u2",
            ]);
        });

        it("re-registering the same user replaces the entry and does not count twice", () => {
            const actor = makeActor();
            actor.registerParticipant(node("u1", { participantId: "old" }));
            actor.registerParticipant(node("u1", { participantId: "new" }));

            expect(actor.getParticipantCount()).toBe(1);
            expect(actor.getSnapshot().members[0].participantId).toBe("new");
        });

        it("rejects a new member when at capacity", () => {
            const actor = makeActor(2);
            actor.registerParticipant(node("u1"));
            actor.registerParticipant(node("u2"));

            expect(() => actor.registerParticipant(node("u3"))).toThrow(
                new BadRequestException(
                    "Room capacity overflow limit reached. Cap: 2",
                ),
            );
            expect(actor.getParticipantCount()).toBe(2);
        });

        it("still accepts a reconnecting member when at capacity", () => {
            const actor = makeActor(2);
            actor.registerParticipant(node("u1"));
            actor.registerParticipant(node("u2"));

            expect(() =>
                actor.registerParticipant(node("u2", { participantId: "again" })),
            ).not.toThrow();
            expect(actor.getParticipantCount()).toBe(2);
        });

        it("eviction frees a slot; evicting an unknown user is a no-op", () => {
            const actor = makeActor(1);
            actor.registerParticipant(node("u1"));

            actor.evictParticipantByUserId("nobody");
            expect(actor.getParticipantCount()).toBe(1);

            actor.evictParticipantByUserId("u1");
            expect(actor.getParticipantCount()).toBe(0);
            expect(() => actor.registerParticipant(node("u2"))).not.toThrow();
        });

        it("snapshot members are live references to the stored nodes", () => {
            // Pinned on purpose: the snapshot copies playback but not member
            // objects, so callers that mutate them mutate the actor.
            const actor = makeActor();
            actor.registerParticipant(node("u1"));
            actor.getSnapshot().members[0].latencyScore = 99;

            expect(actor.getSnapshot().members[0].latencyScore).toBe(99);
        });
    });

    describe("telemetry", () => {
        it("updates a member's latency score", () => {
            const actor = makeActor();
            actor.registerParticipant(node("u1"));
            actor.updateTelemetry({ userId: "u1", score: 42 });

            expect(actor.getSnapshot().members[0].latencyScore).toBe(42);
        });

        it("ignores telemetry for a user who is not a member", () => {
            const actor = makeActor();
            expect(() =>
                actor.updateTelemetry({ userId: "ghost", score: 1 }),
            ).not.toThrow();
            expect(actor.getParticipantCount()).toBe(0);
        });
    });

    describe("playback", () => {
        it("PLAY sets PLAYING, the playhead and the timestamp", () => {
            jest.useFakeTimers({ now: 5_000 });
            const actor = makeActor();

            const state = actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PLAY",
                targetPlayhead: 12.5,
            });

            expect(state).toEqual({
                playhead: 12.5,
                status: "PLAYING",
                lastUpdated: 5_000,
            });
            expect(actor.getSnapshot().playback).toEqual(state);
        });

        it("PAUSE sets PAUSED", () => {
            const actor = makeActor();
            actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PLAY",
                targetPlayhead: 1,
            });
            const state = actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PAUSE",
                targetPlayhead: 3,
            });

            expect(state.status).toBe("PAUSED");
            expect(state.playhead).toBe(3);
        });

        it("SEEK moves the playhead and keeps the current status", () => {
            const actor = makeActor();
            actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PLAY",
                targetPlayhead: 1,
            });
            expect(
                actor.synchronizePlayback({
                    requestingId: OWNER,
                    action: "SEEK",
                    targetPlayhead: 90,
                }),
            ).toMatchObject({ status: "PLAYING", playhead: 90 });

            actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PAUSE",
                targetPlayhead: 90,
            });
            expect(
                actor.synchronizePlayback({
                    requestingId: OWNER,
                    action: "SEEK",
                    targetPlayhead: 10,
                }),
            ).toMatchObject({ status: "PAUSED", playhead: 10 });
        });

        it("rejects playback commands from anyone but the owner and keeps state", () => {
            const actor = makeActor();
            actor.registerParticipant(node("u1"));
            const before = actor.getSnapshot().playback;

            expect(() =>
                actor.synchronizePlayback({
                    requestingId: "u1",
                    action: "PLAY",
                    targetPlayhead: 50,
                }),
            ).toThrow(
                new BadRequestException(
                    "Playback control rejected: only the room owner can control playback.",
                ),
            );
            expect(actor.getSnapshot().playback).toEqual(before);
        });

        it("accepts any numeric playhead without validation (current behaviour)", () => {
            // Pinned on purpose: negative and NaN playheads are not rejected
            // here. If the refactor adds validation, update this test then.
            const actor = makeActor();
            expect(
                actor.synchronizePlayback({
                    requestingId: OWNER,
                    action: "SEEK",
                    targetPlayhead: -5,
                }).playhead,
            ).toBe(-5);
            expect(
                actor.synchronizePlayback({
                    requestingId: OWNER,
                    action: "SEEK",
                    targetPlayhead: Number.NaN,
                }).playhead,
            ).toBeNaN();
        });

        it("returns a copy, not the internal state object", () => {
            const actor = makeActor();
            const state = actor.synchronizePlayback({
                requestingId: OWNER,
                action: "PLAY",
                targetPlayhead: 1,
            });
            state.playhead = 999;

            expect(actor.getSnapshot().playback.playhead).toBe(1);
        });
    });
});
