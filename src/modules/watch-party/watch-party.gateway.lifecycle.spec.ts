import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { WatchPartyGateway } from "./watch-party.gateway.js";
import type { WatchPartyService } from "./watch-party.service.js";
import type { RedisProvider } from "@/shared/infrastructure/cache/redis.provider.js";
import type { LiveKitService } from "../livekit/livekit.service.js";
import type { RoomChatRelay } from "./room-chat.relay.js";
import type { AuthenticatedSocket } from "../auth/auth.types.js";

/*
 * Characterization tests (refactor plan, phase 0) for the gateway's room
 * lifecycle: handshake, reconnection grace, owner termination, voluntary
 * leave, the presence sweeper, playback sync, chat and telemetry.
 *
 * Runs in process: a fake Socket.IO namespace and fake sockets, mocked
 * service / Redis / LiveKit / chat, and Jest fake timers for the 10 s grace.
 * The fake socket's disconnect() calls gateway.handleDisconnect(), as
 * Socket.IO does, so grace scheduling follows the real path.
 *
 * Expected values are copied from today's behaviour. Phase 4 of the refactor
 * moves the runtime maps out of the gateway: `actorFor()` below is the only
 * place these tests read gateway internals, so that is the one helper to
 * repoint then.
 */

const OWNER = "owner-1";
const MEMBER = "member-1";
const ROOM = "room-1";
const CODE = "ABC123";
const GRACE_MS = 10_000;
const TERMINATED = {
    message:
        "The room host has left the session. This watch room has been closed.",
};

type Emit = { room: string; except: string[]; event: string; payload: unknown };

class FakeSocket {
    connected = true;
    readonly rooms = new Set<string>();
    readonly emitted: Array<{ event: string; payload: unknown }> = [];
    readonly data: { user?: { id: string; username: string; email: string; role: string } };

    constructor(
        readonly id: string,
        userId: string | null,
        private readonly onDisconnect: (socket: FakeSocket) => void,
    ) {
        this.data = userId
            ? { user: { id: userId, username: `name-${userId}`, email: `${userId}@x`, role: "user" } }
            : {};
    }

    join(room: string) {
        this.rooms.add(room);
        return Promise.resolve();
    }

    leave(room: string) {
        this.rooms.delete(room);
        return Promise.resolve();
    }

    emit(event: string, payload: unknown) {
        this.emitted.push({ event, payload });
        return true;
    }

    disconnect(_close?: boolean) {
        if (!this.connected) return this;
        this.connected = false;
        this.rooms.clear();
        this.onDisconnect(this);
        return this;
    }

    events(name: string) {
        return this.emitted.filter((e) => e.event === name).map((e) => e.payload);
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>();
    readonly emits: Emit[] = [];

    to(room: string) {
        const except: string[] = [];
        const target = {
            except: (ids: string[]) => {
                except.push(...ids);
                return target;
            },
            emit: (event: string, payload: unknown) => {
                this.emits.push({ room, except: [...except], event, payload });
                return true;
            },
        };
        return target;
    }

    in(room: string) {
        return {
            fetchSockets: async () =>
                [...this.sockets.values()].filter((s) => s.rooms.has(room)),
        };
    }

    events(name: string, room = ROOM) {
        return this.emits.filter((e) => e.event === name && e.room === room);
    }
}

function sessionFor(userId: string, overrides: Record<string, unknown> = {}) {
    return {
        participantId: `part-${userId}`,
        createdMembership: true,
        roomId: ROOM,
        roomCode: CODE,
        movieId: "movie-1",
        ownerId: OWNER,
        maxParticipants: 5,
        participantCount: 1,
        lifecycleVersion: 3,
        ...overrides,
    };
}

function setup() {
    const service = {
        associateParticipant: jest.fn(async ({ userId }: { userId: string }) =>
            sessionFor(userId),
        ),
        disassociateParticipant: jest.fn().mockResolvedValue(null),
        leaveRoomSession: jest.fn(async (userId: string): Promise<Record<string, unknown>> =>
            userId === OWNER
                ? { status: "ROOM_DESTROYED", roomId: ROOM, roomCode: CODE }
                : { status: "PARTICIPANT_EVICTED", roomId: ROOM, roomCode: CODE },
        ),
        assertRoomActive: jest.fn().mockResolvedValue(undefined),
        listActiveMemberships: jest.fn().mockResolvedValue([]),
        getRoomProjectionState: jest.fn(),
    };
    const redis = {
        getRoomState: jest.fn().mockResolvedValue({
            roomId: ROOM,
            lifecycleStatus: "ACTIVE",
        }),
        reconcileRoomState: jest.fn().mockResolvedValue(true),
        updateRoomState: jest.fn().mockResolvedValue(true),
        publicSyncPulse: jest.fn().mockResolvedValue(undefined),
        refreshPresence: jest.fn().mockResolvedValue(undefined),
        getPresence: jest.fn(async (list: unknown[]) => list.map(() => false)),
        clearPresence: jest.fn().mockResolvedValue(undefined),
    };
    const liveKit = {
        getOrCreateMediaSession: jest.fn().mockResolvedValue({ id: "ms-1" }),
    };
    const chat = {
        submit: jest.fn(),
        getRecentHistory: jest.fn().mockResolvedValue([]),
    };

    const gateway = new WatchPartyGateway(
        service as unknown as WatchPartyService,
        redis as unknown as RedisProvider,
        liveKit as unknown as LiveKitService,
        chat as unknown as RoomChatRelay,
    );
    const server = new FakeNamespace();
    (gateway as unknown as { server: FakeNamespace }).server = server;

    let nextId = 0;
    const socket = (userId: string | null) => {
        const s = new FakeSocket(`s${++nextId}`, userId, (closed) => {
            void gateway.handleDisconnect(closed as unknown as AuthenticatedSocket);
        });
        server.sockets.set(s.id, s);
        return s;
    };

    const connect = async (
        s: FakeSocket,
        payload: { leaveCurrent?: boolean } = {},
    ) => {
        await gateway.handleConnectionHandshake(
            s as unknown as AuthenticatedSocket,
            { dto: { roomCode: CODE, passwordPlain: "pw" } as never, ...payload },
        );
        await flush();
    };

    return { gateway, server, service, redis, liveKit, chat, socket, connect };
}

/** Lets fire-and-forget promises (disconnect handling, media startup) settle. */
async function flush() {
    await jest.advanceTimersByTimeAsync(0);
}

function actorFor(gateway: WatchPartyGateway, roomId = ROOM) {
    return (
        gateway as unknown as { runningActors: Map<string, { getSnapshot(): any }> }
    ).runningActors.get(roomId);
}

const asSocket = (s: FakeSocket) => s as unknown as AuthenticatedSocket;

let gatewayUnderTest: WatchPartyGateway | undefined;

beforeAll(() => {
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
});

beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
    gatewayUnderTest?.onModuleDestroy();
    gatewayUnderTest = undefined;
    jest.useRealTimers();
});

function track<T extends { gateway: WatchPartyGateway }>(h: T): T {
    gatewayUnderTest = h.gateway;
    return h;
}

describe("WatchPartyGateway lifecycle", () => {
    describe("room:connect handshake", () => {
        it("rejects a socket without an authenticated user", async () => {
            const h = track(setup());
            const s = h.socket(null);

            await expect(
                h.gateway.handleConnectionHandshake(asSocket(s), {
                    dto: { roomCode: CODE, passwordPlain: "pw" } as never,
                }),
            ).rejects.toThrow(BadRequestException);
            expect(h.service.associateParticipant).not.toHaveBeenCalled();
        });

        it("binds the socket, creates the actor and broadcasts the snapshot", async () => {
            const h = track(setup());
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(h.service.associateParticipant).toHaveBeenCalledWith({
                dto: { roomCode: CODE, passwordPlain: "pw" },
                userId: MEMBER,
            });
            expect(s.rooms.has(ROOM)).toBe(true);
            expect(h.service.assertRoomActive).toHaveBeenCalledTimes(2);
            expect(h.redis.reconcileRoomState).not.toHaveBeenCalled();

            const [first] = h.server.events("room:state_update");
            expect(first.payload).toMatchObject({
                roomId: ROOM,
                roomCode: CODE,
                ownerId: OWNER,
                movieId: "movie-1",
                mediaSessionId: null,
                playback: { playhead: 0, status: "PAUSED" },
                occupancy: { current: 1, max: 5 },
                members: [
                    {
                        participantId: `part-${MEMBER}`,
                        userId: MEMBER,
                        username: `name-${MEMBER}`,
                        latencyScore: 0,
                    },
                ],
            });

            expect(s.events("room:chat:history")).toEqual([
                { roomId: ROOM, messages: [] },
            ]);
            expect(h.redis.refreshPresence).toHaveBeenCalledWith(
                [{ roomId: ROOM, userId: MEMBER }],
                30,
            );
        });

        it("starts media in the background and pushes the session id once ready", async () => {
            const h = track(setup());
            await h.connect(h.socket(MEMBER));

            expect(h.liveKit.getOrCreateMediaSession).toHaveBeenCalledWith(ROOM);
            const updates = h.server.events("room:state_update");
            expect(updates).toHaveLength(2);
            expect(updates[1].payload).toMatchObject({ mediaSessionId: "ms-1" });
        });

        it("retries media startup with backoff while the room stays active", async () => {
            const h = track(setup());
            h.liveKit.getOrCreateMediaSession
                .mockRejectedValueOnce(new Error("livekit down"))
                .mockResolvedValueOnce({ id: "ms-2" });

            await h.connect(h.socket(MEMBER));
            expect(h.server.events("room:state_update")).toHaveLength(1);

            await jest.advanceTimersByTimeAsync(1_000);
            expect(h.liveKit.getOrCreateMediaSession).toHaveBeenCalledTimes(2);
            expect(
                h.server.events("room:state_update").at(-1)?.payload,
            ).toMatchObject({ mediaSessionId: "ms-2" });
        });

        it("stops media startup when the room is no longer active", async () => {
            const h = track(setup());
            h.liveKit.getOrCreateMediaSession.mockRejectedValue(new Error("down"));
            // Two handshake checks pass, then the media loop's check fails.
            h.service.assertRoomActive
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined)
                .mockRejectedValue(new ConflictException("inactive"));

            await h.connect(h.socket(MEMBER));
            await jest.advanceTimersByTimeAsync(60_000);

            expect(h.liveKit.getOrCreateMediaSession).toHaveBeenCalledTimes(1);
        });

        it("restores playback from Redis when it creates the actor", async () => {
            const h = track(setup());
            h.redis.getRoomState.mockResolvedValue({
                roomId: ROOM,
                lifecycleStatus: "ACTIVE",
                playhead: "42.5",
                status: "PLAYING",
            });

            await h.connect(h.socket(MEMBER));

            expect(actorFor(h.gateway)?.getSnapshot().playback).toMatchObject({
                playhead: 42.5,
                status: "PLAYING",
            });
        });

        it("rebuilds a missing Redis projection from the session", async () => {
            const h = track(setup());
            h.redis.getRoomState.mockResolvedValue({});

            await h.connect(h.socket(MEMBER));

            expect(h.redis.reconcileRoomState).toHaveBeenCalledWith(CODE, {
                roomId: ROOM,
                lifecycleVersion: 3,
                lifecycleStatus: "ACTIVE",
                roomCode: CODE,
                ownerId: OWNER,
                movieId: "movie-1",
                maxParticipants: 5,
                participantCount: 1,
                status: "PAUSED",
                playhead: "0",
                lastUpdated: 1_000_000,
            });
        });

        it("a rejected projection fails the handshake and compensates a new membership", async () => {
            const h = track(setup());
            h.redis.getRoomState.mockResolvedValue({});
            h.redis.reconcileRoomState.mockResolvedValue(false);
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(s.events("room:error")).toEqual([
                {
                    message:
                        "The room runtime projection belongs to a different lifecycle generation.",
                    retryable: false,
                },
            ]);
            expect(s.connected).toBe(false);
            expect(h.service.disassociateParticipant).toHaveBeenCalledWith(
                `part-${MEMBER}`,
            );
            expect(actorFor(h.gateway)).toBeUndefined();
        });

        it("a failed handshake on a reused membership keeps it and falls back to grace", async () => {
            const h = track(setup());
            h.service.associateParticipant.mockResolvedValue(
                sessionFor(MEMBER, { createdMembership: false }),
            );
            h.redis.getRoomState.mockRejectedValue(new Error("redis down"));
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(s.events("room:error")).toEqual([
                { message: "redis down", retryable: true },
            ]);
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(GRACE_MS);
            expect(h.service.disassociateParticipant).toHaveBeenCalledWith(
                `part-${MEMBER}`,
            );
        });

        it("forwards a structured conflict so the client can offer a room switch", async () => {
            const h = track(setup());
            h.service.associateParticipant.mockRejectedValue(
                new ConflictException({
                    message:
                        "You are still in room OTH222. Leave it before joining another room.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "room-other",
                        roomCode: "OTH222",
                        isOwner: false,
                    },
                }),
            );
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(s.events("room:error")).toEqual([
                {
                    message:
                        "You are still in room OTH222. Leave it before joining another room.",
                    retryable: false,
                    code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                    currentRoomCode: "OTH222",
                    currentRoomIsOwned: false,
                },
            ]);
            expect(s.connected).toBe(false);
            expect(h.service.leaveRoomSession).not.toHaveBeenCalled();
        });

        it("with leaveCurrent, leaves the other room and joins again", async () => {
            const h = track(setup());
            h.service.associateParticipant
                .mockRejectedValueOnce(
                    new ConflictException({
                        message: "elsewhere",
                        error: {
                            code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                            roomId: "room-other",
                            roomCode: "OTH222",
                            isOwner: true,
                        },
                    }),
                )
                .mockResolvedValueOnce(sessionFor(MEMBER));
            const s = h.socket(MEMBER);

            await h.connect(s, { leaveCurrent: true });

            expect(h.service.leaveRoomSession).toHaveBeenCalledWith(
                MEMBER,
                "room-other",
            );
            expect(h.service.associateParticipant).toHaveBeenCalledTimes(2);
            expect(s.rooms.has(ROOM)).toBe(true);
            expect(s.events("room:error")).toEqual([]);
        });

        it.each([
            ["a 4xx", new BadRequestException("bad password"), false],
            ["an infrastructure error", new Error("db timeout"), true],
        ])("marks %s as retryable=%s", async (_label, error, retryable) => {
            const h = track(setup());
            h.service.associateParticipant.mockRejectedValue(error);
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(s.events("room:error")).toEqual([
                { message: (error as Error).message, retryable },
            ]);
        });

        it("sends room:terminated, not room:error, when the room ends mid-handshake", async () => {
            const h = track(setup());
            h.service.assertRoomActive
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new ConflictException("inactive"));
            const s = h.socket(MEMBER);

            await h.connect(s);

            expect(s.events("room:terminated")).toEqual([TERMINATED]);
            expect(s.events("room:error")).toEqual([]);
            expect(s.rooms.has(ROOM)).toBe(false);
        });

        it("replaces a stale socket of the same user without starting grace", async () => {
            const h = track(setup());
            const oldSocket = h.socket(MEMBER);
            await h.connect(oldSocket);
            h.service.associateParticipant.mockResolvedValue(
                sessionFor(MEMBER, { createdMembership: false }),
            );

            const newSocket = h.socket(MEMBER);
            await h.connect(newSocket);
            await jest.advanceTimersByTimeAsync(GRACE_MS * 2);

            expect(oldSocket.connected).toBe(false);
            expect(newSocket.connected).toBe(true);
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
            expect(actorFor(h.gateway)?.getSnapshot().occupancy.current).toBe(1);
        });
    });

    describe("reconnection grace (connection loss)", () => {
        it("a participant who stays away 10 s loses the membership", async () => {
            const h = track(setup());
            await h.connect(h.socket(OWNER));
            const member = h.socket(MEMBER);
            await h.connect(member);

            member.disconnect();
            await flush();
            expect(h.redis.clearPresence).toHaveBeenCalledWith(ROOM, MEMBER);

            await jest.advanceTimersByTimeAsync(GRACE_MS - 1);
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(1);
            expect(h.service.disassociateParticipant).toHaveBeenCalledWith(
                `part-${MEMBER}`,
            );
            expect(h.server.events("room:member_left").map((e) => e.payload)).toEqual([
                { userId: MEMBER },
            ]);
            expect(actorFor(h.gateway)?.getSnapshot().occupancy.current).toBe(1);
        });

        it("releases the actor when the last participant's grace expires", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);

            member.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS);

            expect(actorFor(h.gateway)).toBeUndefined();
        });

        it("reconnecting within the grace keeps the membership", async () => {
            const h = track(setup());
            const first = h.socket(MEMBER);
            await h.connect(first);

            first.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS - 1_000);

            h.service.associateParticipant.mockResolvedValue(
                sessionFor(MEMBER, { createdMembership: false }),
            );
            await h.connect(h.socket(MEMBER));
            await jest.advanceTimersByTimeAsync(GRACE_MS * 3);

            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
            expect(h.server.events("room:member_left")).toEqual([]);
        });

        it("skips cleanup when a presence key shows the user is still connected", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            h.redis.getPresence.mockResolvedValue([true]);

            member.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS);

            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
        });

        it("an owner who stays away 10 s terminates the room for everyone", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            const member = h.socket(MEMBER);
            await h.connect(member);

            owner.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS);

            expect(h.service.leaveRoomSession).toHaveBeenCalledWith(OWNER, ROOM);
            expect(h.server.events("room:terminated")).toEqual([
                { room: ROOM, except: [], event: "room:terminated", payload: TERMINATED },
            ]);
            expect(member.connected).toBe(false);
            expect(actorFor(h.gateway)).toBeUndefined();
        });

        it("retries a failed owner cleanup every 5 s until it succeeds", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            h.service.leaveRoomSession
                .mockRejectedValueOnce(new Error("db down"))
                .mockRejectedValueOnce(new Error("db down"));

            owner.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS);
            expect(h.service.leaveRoomSession).toHaveBeenCalledTimes(1);

            await jest.advanceTimersByTimeAsync(5_000);
            expect(h.service.leaveRoomSession).toHaveBeenCalledTimes(2);

            await jest.advanceTimersByTimeAsync(5_000);
            expect(h.service.leaveRoomSession).toHaveBeenCalledTimes(3);
            expect(h.server.events("room:terminated")).toHaveLength(1);

            await jest.advanceTimersByTimeAsync(30_000);
            expect(h.service.leaveRoomSession).toHaveBeenCalledTimes(3);
        });

        it("a disconnect of an unbound socket does nothing", async () => {
            const h = track(setup());
            const s = h.socket(MEMBER);

            s.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS);

            expect(h.redis.clearPresence).not.toHaveBeenCalled();
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
        });
    });

    describe("room:leave (voluntary)", () => {
        it("participant leave is immediate and schedules no grace", async () => {
            const h = track(setup());
            await h.connect(h.socket(OWNER));
            const member = h.socket(MEMBER);
            await h.connect(member);

            const ack = await h.gateway.handleLeaveRoom(asSocket(member));

            expect(ack).toEqual({ ok: true, status: "PARTICIPANT_EVICTED" });
            expect(h.service.leaveRoomSession).toHaveBeenCalledWith(MEMBER, ROOM);
            expect(h.redis.clearPresence).toHaveBeenCalledWith(ROOM, MEMBER);
            expect(h.server.events("room:member_left")).toEqual([
                {
                    room: ROOM,
                    except: [member.id],
                    event: "room:member_left",
                    payload: { userId: MEMBER },
                },
            ]);
            expect(member.rooms.has(ROOM)).toBe(false);
            // The requester disconnects itself after the ack.
            expect(member.connected).toBe(true);

            member.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS * 2);
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
        });

        it("owner leave closes the room for everyone else", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            const member = h.socket(MEMBER);
            await h.connect(member);

            const ack = await h.gateway.handleLeaveRoom(asSocket(owner));

            expect(ack).toEqual({ ok: true, status: "ROOM_DESTROYED" });
            expect(h.server.events("room:terminated")).toEqual([
                {
                    room: ROOM,
                    except: [owner.id],
                    event: "room:terminated",
                    payload: TERMINATED,
                },
            ]);
            expect(member.connected).toBe(false);
            expect(owner.connected).toBe(true);
            expect(actorFor(h.gateway)).toBeUndefined();
        });

        it("a user has one live tab per room: a second tab disconnects the first", async () => {
            // Pinned on purpose: the handshake disconnects any other socket of
            // the same user in the same room, so leave's "other tab gets
            // room:left" path only runs for a binding caught mid-handshake.
            const h = track(setup());
            const tabA = h.socket(MEMBER);
            await h.connect(tabA);
            const tabB = h.socket(MEMBER);
            await h.connect(tabB);

            expect(tabA.connected).toBe(false);
            expect(tabA.events("room:left")).toEqual([]);

            const ack = await h.gateway.handleLeaveRoom(asSocket(tabB));
            expect(ack).toEqual({ ok: true, status: "PARTICIPANT_EVICTED" });
        });

        it("REST leave during a pending grace cancels the grace timer", async () => {
            // POST /rooms/:roomId/leave calls leaveRoomVoluntarily with no
            // socket: the client dropped, then fell back to REST.
            const h = track(setup());
            await h.connect(h.socket(OWNER));
            const member = h.socket(MEMBER);
            await h.connect(member);
            member.disconnect();
            await jest.advanceTimersByTimeAsync(GRACE_MS / 2);

            const status = await h.gateway.leaveRoomVoluntarily(MEMBER, ROOM);
            await jest.advanceTimersByTimeAsync(GRACE_MS * 2);

            expect(status).toBe("PARTICIPANT_EVICTED");
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
            expect(h.server.events("room:member_left")).toHaveLength(1);
        });

        it("NOT_BOUND for a socket that is not in a room", async () => {
            const h = track(setup());

            expect(await h.gateway.handleLeaveRoom(asSocket(h.socket(MEMBER)))).toEqual({
                ok: true,
                status: "NOT_BOUND",
            });
        });

        it("rejects an unauthenticated socket", async () => {
            const h = track(setup());

            expect(await h.gateway.handleLeaveRoom(asSocket(h.socket(null)))).toEqual({
                ok: false,
                message: "Leave rejected: socket is not authenticated.",
            });
        });

        it("reports a failed leave so the client can fall back to REST", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            h.service.leaveRoomSession.mockRejectedValue(new Error("db down"));

            expect(await h.gateway.handleLeaveRoom(asSocket(member))).toEqual({
                ok: false,
                message: "db down",
            });
        });

        it("is idempotent: NO_ACTIVE_SESSION is acknowledged without fan-out", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            h.service.leaveRoomSession.mockResolvedValue({
                status: "NO_ACTIVE_SESSION",
            });

            expect(await h.gateway.handleLeaveRoom(asSocket(member))).toEqual({
                ok: true,
                status: "NO_ACTIVE_SESSION",
            });
            expect(h.server.events("room:member_left")).toEqual([]);
            expect(h.server.events("room:terminated")).toEqual([]);
        });
    });

    describe("presence sweeper", () => {
        const membership = {
            participantId: `part-${MEMBER}`,
            roomId: ROOM,
            roomCode: CODE,
            userId: MEMBER,
            isOwner: false,
        };

        it("puts a membership with no socket and no presence key into grace", async () => {
            const h = track(setup());
            h.service.listActiveMemberships.mockResolvedValue([membership]);
            h.gateway.onModuleInit();

            await jest.advanceTimersByTimeAsync(15_000);
            expect(h.redis.getPresence).toHaveBeenCalledWith([membership]);
            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(GRACE_MS);
            expect(h.service.disassociateParticipant).toHaveBeenCalledWith(
                `part-${MEMBER}`,
            );
        });

        it("leaves a membership alone while its presence key exists", async () => {
            const h = track(setup());
            h.service.listActiveMemberships.mockResolvedValue([membership]);
            h.redis.getPresence.mockResolvedValue([true]);
            h.gateway.onModuleInit();

            await jest.advanceTimersByTimeAsync(15_000 + GRACE_MS);

            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
        });

        it("skips the round when presence cannot be read", async () => {
            const h = track(setup());
            h.service.listActiveMemberships.mockResolvedValue([membership]);
            h.redis.getPresence.mockRejectedValue(new Error("redis down"));
            h.gateway.onModuleInit();

            await jest.advanceTimersByTimeAsync(15_000 + GRACE_MS);

            expect(h.service.disassociateParticipant).not.toHaveBeenCalled();
        });

        it("ignores members bound to a live socket here", async () => {
            const h = track(setup());
            await h.connect(h.socket(MEMBER));
            h.service.listActiveMemberships.mockResolvedValue([membership]);
            h.gateway.onModuleInit();

            await jest.advanceTimersByTimeAsync(15_000);

            expect(h.redis.getPresence).not.toHaveBeenCalled();
        });

        it("refreshes presence for live bindings every 10 s", async () => {
            const h = track(setup());
            await h.connect(h.socket(MEMBER));
            h.redis.refreshPresence.mockClear();
            h.gateway.onModuleInit();

            await jest.advanceTimersByTimeAsync(10_000);

            expect(h.redis.refreshPresence).toHaveBeenCalledWith(
                [membership],
                30,
            );
        });
    });

    describe("room:sync:pulse", () => {
        const pulse = (action: "PLAY" | "PAUSE" | "SEEK", playhead: number) => ({
            roomId: "ignored",
            roomCode: "ignored",
            action,
            playhead,
        });

        it("owner pulse updates Redis, broadcasts and publishes", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);

            await h.gateway.handlePlaybackPulse(asSocket(owner), pulse("PLAY", 12));

            expect(h.redis.updateRoomState).toHaveBeenCalledWith(
                CODE,
                { status: "PLAYING", playhead: 12, lastUpdated: 1_000_000 },
                ROOM,
            );
            const expected = {
                action: "PLAY",
                playhead: 12,
                originatorId: OWNER,
                serverExecutionTime: 1_000_000,
            };
            expect(h.server.events("room:sync:broadcast").map((e) => e.payload)).toEqual([
                expected,
            ]);
            expect(h.redis.publicSyncPulse).toHaveBeenCalledWith(CODE, expected);
        });

        it("a non-owner pulse is answered with room:error and not broadcast", async () => {
            const h = track(setup());
            await h.connect(h.socket(OWNER));
            const member = h.socket(MEMBER);
            await h.connect(member);

            await h.gateway.handlePlaybackPulse(asSocket(member), pulse("PLAY", 5));

            expect(member.events("room:error")).toEqual([
                {
                    message:
                        "Playback control rejected: only the room owner can control playback.",
                },
            ]);
            expect(h.server.events("room:sync:broadcast")).toEqual([]);
        });

        it("rejects a pulse from an unbound socket", async () => {
            const h = track(setup());

            await expect(
                h.gateway.handlePlaybackPulse(asSocket(h.socket(OWNER)), pulse("PLAY", 1)),
            ).rejects.toThrow("Playback pulse rejected: socket is not bound to a room.");
        });

        it("repairs a rejected projection write and still broadcasts", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            h.redis.updateRoomState.mockResolvedValue(false);
            h.service.getRoomProjectionState.mockResolvedValue({
                roomId: ROOM,
                roomCode: CODE,
                ownerId: OWNER,
                movieId: "movie-1",
                maxParticipants: 5,
                lifecycleStatus: "ACTIVE",
                stateVersion: "4",
                participantCount: 1,
            });

            await h.gateway.handlePlaybackPulse(asSocket(owner), pulse("SEEK", 30));

            expect(h.redis.reconcileRoomState).toHaveBeenCalledWith(CODE, {
                roomId: ROOM,
                lifecycleVersion: "4",
                lifecycleStatus: "ACTIVE",
                roomCode: CODE,
                ownerId: OWNER,
                movieId: "movie-1",
                maxParticipants: 5,
                participantCount: 1,
                status: "PAUSED",
                playhead: 30,
                lastUpdated: 1_000_000,
            });
            expect(h.server.events("room:sync:broadcast")).toHaveLength(1);
        });

        it("drops the pulse when the repair finds the room no longer ACTIVE", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            h.redis.updateRoomState.mockRejectedValue(new Error("redis down"));
            h.service.getRoomProjectionState.mockResolvedValue({
                lifecycleStatus: "TERMINATING",
            });

            await h.gateway.handlePlaybackPulse(asSocket(owner), pulse("PLAY", 1));

            expect(h.server.events("room:sync:broadcast")).toEqual([]);
            expect(owner.events("room:error")).toEqual([]);
        });

        it("keeps the room usable when the repair cannot read room state", async () => {
            const h = track(setup());
            const owner = h.socket(OWNER);
            await h.connect(owner);
            h.redis.updateRoomState.mockResolvedValue(false);
            h.service.getRoomProjectionState.mockRejectedValue(new Error("db down"));

            await h.gateway.handlePlaybackPulse(asSocket(owner), pulse("PAUSE", 2));

            expect(h.server.events("room:sync:broadcast")).toHaveLength(1);
        });
    });

    describe("room:chat:message", () => {
        it("NOT_IN_ROOM for an unbound socket", async () => {
            const h = track(setup());

            expect(
                await h.gateway.handleChatMessage(asSocket(h.socket(MEMBER)), {
                    message: "hi",
                }),
            ).toEqual({
                ok: false,
                code: "NOT_IN_ROOM",
                message: "Join the room before sending messages.",
            });
            expect(h.chat.submit).not.toHaveBeenCalled();
        });

        it("posts to the bound room (body roomCode ignored), broadcasts and acks", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            const payload = { id: "msg-1", timestamp: 123, message: "hi" };
            h.chat.submit.mockResolvedValue({ accepted: true, payload });

            const ack = await h.gateway.handleChatMessage(asSocket(member), {
                roomCode: "OTHER1",
                message: "hi",
                clientMessageId: "c-1",
            });

            expect(h.chat.submit).toHaveBeenCalledWith({
                roomId: ROOM,
                userId: MEMBER,
                username: `name-${MEMBER}`,
                rawMessage: "hi",
                rawClientMessageId: "c-1",
            });
            expect(ack).toEqual({ ok: true, id: "msg-1", timestamp: 123 });
            expect(h.server.events("room:chat:broadcast").map((e) => e.payload)).toEqual([
                payload,
            ]);
        });

        it("returns the relay's rejection without broadcasting", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            const rejection = {
                ok: false,
                code: "RATE_LIMITED",
                message: "Slow down.",
                retryAfterMs: 4_000,
            };
            h.chat.submit.mockResolvedValue({ accepted: false, ack: rejection });

            expect(
                await h.gateway.handleChatMessage(asSocket(member), { message: "x" }),
            ).toEqual(rejection);
            expect(h.server.events("room:chat:broadcast")).toEqual([]);
        });

        it("does not broadcast when the socket left the room while the insert ran", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);
            h.chat.submit.mockImplementation(async () => {
                await h.gateway.handleLeaveRoom(asSocket(member));
                return { accepted: true, payload: { id: "m", timestamp: 1 } };
            });

            expect(
                await h.gateway.handleChatMessage(asSocket(member), { message: "x" }),
            ).toEqual({
                ok: false,
                code: "NOT_IN_ROOM",
                message: "You are no longer in this room.",
            });
            expect(h.server.events("room:chat:broadcast")).toEqual([]);
        });
    });

    describe("clock:sync and telemetry", () => {
        it("clock:sync echoes a finite client time and stamps server times", () => {
            const h = track(setup());

            expect(h.gateway.handleClockSync({ clientSendTime: 5 })).toEqual({
                clientSendTime: 5,
                serverReceiveTime: 1_000_000,
                serverSendTime: 1_000_000,
            });
            expect(h.gateway.handleClockSync({ clientSendTime: Number.NaN })).toMatchObject({
                clientSendTime: null,
            });
            expect(h.gateway.handleClockSync(undefined)).toMatchObject({
                clientSendTime: null,
            });
        });

        it("telemetry records the round trip on the actor and answers with a pong", async () => {
            const h = track(setup());
            const member = h.socket(MEMBER);
            await h.connect(member);

            h.gateway.handleNetworkTelemetry(asSocket(member), {
                roomId: "spoofed",
                userId: "spoofed",
                clientTimestamp: 1_000_000 - 80,
            });

            expect(member.events("room:telemetry:pong")).toEqual([
                { currentLatency: 80 },
            ]);
            expect(actorFor(h.gateway)?.getSnapshot().members[0].latencyScore).toBe(80);
        });

        it("telemetry from an unbound socket is rejected", () => {
            const h = track(setup());

            expect(() =>
                h.gateway.handleNetworkTelemetry(asSocket(h.socket(MEMBER)), {
                    roomId: ROOM,
                    userId: MEMBER,
                    clientTimestamp: 0,
                }),
            ).toThrow("Telemetry transmission rejected: socket is not bound to a room.");
        });
    });
});
