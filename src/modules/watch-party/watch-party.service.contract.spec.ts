import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { WatchPartyService } from "./watch-party.service.js";
import type { WatchPartyStore } from "./application/ports/watch-party-store.port.js";
import {
    ActiveMembershipConflict,
    RoomCodeConflict,
} from "./application/ports/store-errors.js";
import { BcryptPasswordHasher } from "./infrastructure/security/bcrypt-password-hasher.js";
import type { RoomLifecycleOutboxService } from "./room-lifecycle-outbox.service.js";
import {
    JOIN_PASSWORD_RULE,
    type AttemptLimiter,
} from "@/shared/infrastructure/cache/attempt-limiter.js";

/*
 * Characterization tests (refactor plan, phase 0): the service's decisions and
 * its error contract. The frontend switches on these statuses, messages and
 * `error.code` payloads (switch-room prompt, auth recovery UX), so every
 * expected value here is copied from today's behaviour. Changing one is a
 * client-visible change.
 *
 * The repository is mocked: these tests pin the service's branching, not SQL.
 * SQL and locking are covered by the real-Postgres integration tests.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MOVIE = "33333333-3333-4333-8333-333333333333";
const TX = { __tx: true };

type Mocked<T> = { [K in keyof T]: jest.Mock };

let roomPasswordHash: string;

beforeAll(async () => {
    roomPasswordHash = await bcrypt.hash("right-pass", 4);
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
});

function makeRepo() {
    const repo = {
        withTransaction: jest.fn(async (cb: (tx: unknown) => unknown) =>
            cb(TX),
        ),
        acquireOwnerRoomCreationLock: jest.fn(),
        findOwnedLiveRoom: jest.fn().mockResolvedValue(undefined),
        deactivateMembershipsInTerminatedRooms: jest.fn(),
        findCurrentRoom: jest.fn().mockResolvedValue(undefined),
        insertProvisioningRoom: jest.fn(async (_tx, p) => ({
            id: "room-new",
            room_code: p.roomCode,
            max_participants: p.maxParticipants,
        })),
        insertOwnerParticipant: jest.fn(),
        lockLiveRoomByCode: jest.fn(),
        findActiveParticipant: jest.fn().mockResolvedValue(undefined),
        countActiveParticipants: jest.fn().mockResolvedValue(1),
        insertParticipant: jest.fn().mockResolvedValue({ id: "part-new" }),
        incrementActiveRoomStateVersion: jest.fn().mockResolvedValue(8),
        findParticipantRoomId: jest.fn(),
        lockRoomStatus: jest.fn(),
        deactivateParticipant: jest.fn(),
        incrementRoomStateVersion: jest.fn(),
        lockUserLiveSession: jest.fn(),
        findRoomLifecycle: jest.fn(),
        listActiveMemberUserIds: jest.fn(),
        markRoomTerminating: jest.fn(),
        deactivateAllRoomParticipants: jest.fn(),
        deactivateUserMembership: jest.fn(),
        findActiveRoomDetailsByCode: jest.fn(),
        isRoomActive: jest.fn(),
        listActiveMemberships: jest.fn(),
        findRoomProjection: jest.fn(),
    };
    return repo;
}

function setup() {
    const repo = makeRepo();
    const outbox = {
        enqueueRoomReconciliation: jest.fn(),
        provisionRoomNow: jest.fn().mockResolvedValue(undefined),
    };
    const limiter: Mocked<
        Pick<AttemptLimiter, "assertAllowed" | "recordFailure" | "reset">
    > = {
        assertAllowed: jest.fn(),
        recordFailure: jest.fn(),
        reset: jest.fn(),
    };
    const service = new WatchPartyService(
        repo as unknown as WatchPartyStore,
        outbox as unknown as RoomLifecycleOutboxService,
        limiter as unknown as AttemptLimiter,
        new BcryptPasswordHasher(),
    );
    return { service, repo, outbox, limiter };
}

/** Status + response body exactly as Nest would serialize them. */
async function contractOf(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return { status: error.getStatus(), body: error.getResponse() };
        }
        throw error;
    }
    throw new Error("Expected the call to throw an HttpException");
}

/**
 * What the store reports for a unique violation on `constraint`. Since phase 2
 * the Postgres repository translates the driver error itself (covered end to
 * end by watch-party.service.int-spec.ts), so the mocked store throws the
 * translated conflict.
 */
function pgUniqueViolation(constraint: string) {
    const cause = Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint,
    });
    if (constraint === "idx_active_room_code") return new RoomCodeConflict({ cause });
    if (constraint === "idx_one_active_room_per_user") {
        return new ActiveMembershipConflict({ cause });
    }
    throw new Error(`No store conflict for ${constraint}`);
}

function liveRoom(overrides: Record<string, unknown> = {}) {
    return {
        id: "room-1",
        room_code: "ABC123",
        owner_id: OWNER,
        movie_id: MOVIE,
        max_participants: 5,
        state_version: 3,
        lifecycle_status: "ACTIVE",
        password: roomPasswordHash,
        ...overrides,
    };
}

const createDto = (extra: Record<string, unknown> = {}) => ({
    passwordPlain: "secret-pass",
    movieId: MOVIE,
    ...extra,
});

describe("WatchPartyService contract", () => {
    describe("createRoomSession", () => {
        it.each([
            ["too short", "abc"],
            ["blank after trim", "      "],
            ["too long", "x".repeat(65)],
            ["missing", undefined],
        ])("rejects a %s password with 400", async (_label, passwordPlain) => {
            const { service, repo } = setup();

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto({ passwordPlain }) as never,
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.BAD_REQUEST,
                body: {
                    statusCode: 400,
                    error: "Bad Request",
                    message:
                        "A room password of 4-64 characters is required.",
                },
            });
            expect(repo.withTransaction).not.toHaveBeenCalled();
        });

        it("409 ACTIVE_OWNER_ROOM when the owner already has a live room", async () => {
            const { service, repo } = setup();
            repo.findOwnedLiveRoom.mockResolvedValue({
                id: "room-old",
                room_code: "OLD111",
            });

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto(),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "You already have an active room (OLD111). Close it before creating another room.",
                    error: {
                        code: "ACTIVE_OWNER_ROOM",
                        roomId: "room-old",
                        roomCode: "OLD111",
                        isOwner: true,
                    },
                },
            });
            expect(repo.insertProvisioningRoom).not.toHaveBeenCalled();
        });

        it("409 ACTIVE_MEMBERSHIP_ELSEWHERE when the owner is a member of another room", async () => {
            const { service, repo } = setup();
            repo.findCurrentRoom.mockResolvedValue({
                id: "room-other",
                room_code: "OTH222",
                is_owner: false,
            });

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto(),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "You are still in room OTH222. Leave it before joining another room.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "room-other",
                        roomCode: "OTH222",
                        isOwner: false,
                    },
                },
            });
            // Stale memberships in terminated rooms are cleared before the check.
            expect(
                repo.deactivateMembershipsInTerminatedRooms,
            ).toHaveBeenCalledWith(TX, OWNER);
        });

        it("creates the room, owner membership and outbox event in one transaction", async () => {
            const { service, repo, outbox } = setup();

            const result = await service.createRoomSession({
                dto: createDto({ roomCode: "ab12cd" }),
                ownerId: OWNER,
            });

            expect(result).toEqual({
                roomId: "room-new",
                roomCode: "AB12CD",
                maxParticipants: 5,
                lifecycleStatus: "ACTIVE",
            });
            expect(repo.withTransaction).toHaveBeenCalledTimes(1);
            expect(repo.acquireOwnerRoomCreationLock).toHaveBeenCalledWith(
                TX,
                OWNER,
            );
            const inserted = repo.insertProvisioningRoom.mock.calls[0][1];
            expect(inserted).toMatchObject({
                roomCode: "AB12CD",
                ownerId: OWNER,
                movieId: MOVIE,
                maxParticipants: 5,
            });
            expect(
                await bcrypt.compare("secret-pass", inserted.passwordHash),
            ).toBe(true);
            expect(outbox.enqueueRoomReconciliation).toHaveBeenCalledWith(
                TX,
                "room-new",
            );
            expect(repo.insertOwnerParticipant).toHaveBeenCalledWith(
                TX,
                "room-new",
                OWNER,
            );
            expect(outbox.provisionRoomNow).toHaveBeenCalledWith("room-new");
        });

        it("reports PROVISIONING, not an error, when inline provisioning fails", async () => {
            const { service, outbox } = setup();
            outbox.provisionRoomNow.mockRejectedValue(new Error("livekit down"));

            const result = await service.createRoomSession({
                dto: createDto({ maxParticipants: 8 }),
                ownerId: OWNER,
            });

            expect(result.lifecycleStatus).toBe("PROVISIONING");
            expect(result.maxParticipants).toBe(8);
        });

        it("generates a 6-character code when none is requested", async () => {
            const { service } = setup();
            const result = await service.createRoomSession({
                dto: createDto(),
                ownerId: OWNER,
            });
            expect(result.roomCode).toMatch(/^[A-Z0-9]{6}$/);
        });

        it("409 ROOM_CODE_IN_USE for a requested code that is taken (no retry)", async () => {
            const { service, repo } = setup();
            repo.insertProvisioningRoom.mockRejectedValue(
                pgUniqueViolation("idx_active_room_code"),
            );

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto({ roomCode: "TAKEN1" }),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "Room code TAKEN1 is already in use. Choose another code.",
                    error: { code: "ROOM_CODE_IN_USE" },
                },
            });
            expect(repo.insertProvisioningRoom).toHaveBeenCalledTimes(1);
        });

        it("retries a generated code collision and succeeds", async () => {
            const { service, repo } = setup();
            repo.insertProvisioningRoom.mockRejectedValueOnce(
                pgUniqueViolation("idx_active_room_code"),
            );

            const result = await service.createRoomSession({
                dto: createDto(),
                ownerId: OWNER,
            });

            expect(result.roomId).toBe("room-new");
            expect(repo.insertProvisioningRoom).toHaveBeenCalledTimes(2);
        });

        it("gives up after 5 generated code collisions with 409 ROOM_CODE_IN_USE", async () => {
            const { service, repo } = setup();
            repo.insertProvisioningRoom.mockRejectedValue(
                pgUniqueViolation("idx_active_room_code"),
            );

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto(),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "Could not allocate a unique room code. Please try again.",
                    error: { code: "ROOM_CODE_IN_USE" },
                },
            });
            expect(repo.insertProvisioningRoom).toHaveBeenCalledTimes(5);
        });

        it("maps a concurrent-join unique violation to ACTIVE_MEMBERSHIP_ELSEWHERE (owner wording)", async () => {
            const { service, repo } = setup();
            repo.insertOwnerParticipant.mockRejectedValue(
                pgUniqueViolation("idx_one_active_room_per_user"),
            );
            // Inside the transaction there is no current room; after the
            // violation the pool lookup finds the room that won the race.
            repo.findCurrentRoom
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({
                    id: "room-race",
                    room_code: "RACE01",
                    is_owner: true,
                });

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto(),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "You are still hosting room RACE01. Leaving it will close it for everyone.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "room-race",
                        roomCode: "RACE01",
                        isOwner: true,
                    },
                },
            });
            expect(repo.findCurrentRoom).toHaveBeenLastCalledWith(
                undefined,
                OWNER,
                undefined,
            );
        });

        it("plain 409 when the concurrent-join room can no longer be found", async () => {
            const { service, repo } = setup();
            repo.insertOwnerParticipant.mockRejectedValue(
                pgUniqueViolation("idx_one_active_room_per_user"),
            );

            expect(
                await contractOf(
                    service.createRoomSession({
                        dto: createDto(),
                        ownerId: OWNER,
                    }),
                ),
            ).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    statusCode: 409,
                    error: "Conflict",
                    message: "You already belong to an active watch room.",
                },
            });
        });

        it("rethrows unknown database errors unchanged", async () => {
            const { service, repo } = setup();
            const boom = new Error("connection reset");
            repo.insertProvisioningRoom.mockRejectedValue(boom);

            await expect(
                service.createRoomSession({ dto: createDto(), ownerId: OWNER }),
            ).rejects.toBe(boom);
        });
    });

    describe("associateParticipant (join)", () => {
        const join = (
            service: WatchPartyService,
            passwordPlain: unknown,
            userId = USER,
            roomCode = " abc123 ",
        ) =>
            service.associateParticipant({
                dto: { roomCode, passwordPlain } as never,
                userId,
            });

        it("400 for a non-UUID user id, before touching the database", async () => {
            const { service, repo } = setup();

            expect(await contractOf(join(service, "x", "not-a-uuid"))).toEqual({
                status: HttpStatus.BAD_REQUEST,
                body: {
                    statusCode: 400,
                    error: "Bad Request",
                    message:
                        "An authenticated user UUID is required to join a room.",
                },
            });
            expect(repo.withTransaction).not.toHaveBeenCalled();
        });

        it("503 while the room is still PROVISIONING", async () => {
            const { service, repo } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(
                liveRoom({ lifecycle_status: "PROVISIONING" }),
            );

            expect(await contractOf(join(service, "right-pass"))).toEqual({
                status: HttpStatus.SERVICE_UNAVAILABLE,
                body: {
                    statusCode: 503,
                    error: "Service Unavailable",
                    message:
                        "The watch room is still being prepared. Retrying shortly.",
                },
            });
        });

        it("404 when no live room has the code; code is trimmed and uppercased", async () => {
            const { service, repo } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(undefined);

            expect(await contractOf(join(service, "right-pass"))).toEqual({
                status: HttpStatus.NOT_FOUND,
                body: {
                    statusCode: 404,
                    error: "Not Found",
                    message:
                        "Handshake rejected: No matching active room stream code sequence.",
                },
            });
            expect(repo.lockLiveRoomByCode).toHaveBeenCalledWith(TX, "ABC123");
        });

        it.each([["empty", ""], ["blank", "   "], ["missing", undefined]])(
            "400 for a %s password without counting an attempt",
            async (_label, passwordPlain) => {
                const { service, repo, limiter } = setup();
                repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());

                expect(await contractOf(join(service, passwordPlain))).toEqual({
                    status: HttpStatus.BAD_REQUEST,
                    body: {
                        statusCode: 400,
                        error: "Bad Request",
                        message:
                            "This room is password protected. Enter the room password to join.",
                    },
                });
                expect(limiter.assertAllowed).not.toHaveBeenCalled();
                expect(limiter.recordFailure).not.toHaveBeenCalled();
            },
        );

        it("propagates the attempt limiter's 429 before comparing the password", async () => {
            const { service, repo, limiter } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            const tooMany = new HttpException(
                "Too many attempts",
                HttpStatus.TOO_MANY_REQUESTS,
            );
            limiter.assertAllowed.mockRejectedValue(tooMany);

            await expect(join(service, "wrong")).rejects.toBe(tooMany);
            expect(limiter.assertAllowed).toHaveBeenCalledWith(
                JOIN_PASSWORD_RULE,
                `room-1:${USER}`,
            );
            expect(limiter.recordFailure).not.toHaveBeenCalled();
        });

        it("400 for a wrong password and records the failure", async () => {
            const { service, repo, limiter } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());

            expect(await contractOf(join(service, "wrong-pass"))).toEqual({
                status: HttpStatus.BAD_REQUEST,
                body: {
                    statusCode: 400,
                    error: "Bad Request",
                    message:
                        "Security credentials verification failure: Authentication rejected.",
                },
            });
            expect(limiter.recordFailure).toHaveBeenCalledWith(
                JOIN_PASSWORD_RULE,
                `room-1:${USER}`,
            );
            expect(repo.insertParticipant).not.toHaveBeenCalled();
        });

        it("first join with the right password creates a membership and bumps the state version", async () => {
            const { service, repo, outbox, limiter } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            repo.countActiveParticipants
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(2);

            expect(await join(service, "right-pass")).toEqual({
                participantId: "part-new",
                createdMembership: true,
                roomId: "room-1",
                roomCode: "ABC123",
                movieId: MOVIE,
                ownerId: OWNER,
                maxParticipants: 5,
                participantCount: 2,
                lifecycleVersion: 8,
            });
            expect(limiter.reset).toHaveBeenCalledWith(
                JOIN_PASSWORD_RULE,
                `room-1:${USER}`,
            );
            expect(repo.findCurrentRoom).toHaveBeenCalledWith(
                TX,
                USER,
                "room-1",
            );
            expect(repo.incrementActiveRoomStateVersion).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
            expect(outbox.enqueueRoomReconciliation).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
        });

        it("the owner joins without a password", async () => {
            const { service, repo, limiter } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            repo.findActiveParticipant.mockResolvedValue({
                id: "part-owner",
                has_control_privilege: true,
            });

            const result = await join(service, undefined, OWNER);

            expect(result.participantId).toBe("part-owner");
            expect(limiter.assertAllowed).not.toHaveBeenCalled();
        });

        it("a reconnect reuses the active row: no password, no insert, no version bump", async () => {
            const { service, repo, outbox, limiter } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            repo.findActiveParticipant.mockResolvedValue({
                id: "part-existing",
                has_control_privilege: false,
            });
            repo.countActiveParticipants.mockResolvedValue(3);

            expect(await join(service, undefined)).toEqual({
                participantId: "part-existing",
                createdMembership: false,
                roomId: "room-1",
                roomCode: "ABC123",
                movieId: MOVIE,
                ownerId: OWNER,
                maxParticipants: 5,
                participantCount: 3,
                lifecycleVersion: 3,
            });
            expect(limiter.assertAllowed).not.toHaveBeenCalled();
            expect(repo.insertParticipant).not.toHaveBeenCalled();
            expect(repo.incrementActiveRoomStateVersion).not.toHaveBeenCalled();
            expect(outbox.enqueueRoomReconciliation).not.toHaveBeenCalled();
        });

        it("400 when the room is full", async () => {
            const { service, repo } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(
                liveRoom({ max_participants: 2 }),
            );
            repo.countActiveParticipants.mockResolvedValue(2);

            expect(await contractOf(join(service, "right-pass"))).toEqual({
                status: HttpStatus.BAD_REQUEST,
                body: {
                    statusCode: 400,
                    error: "Bad Request",
                    message: "Room capacity overflow limit reached. Cap: 2",
                },
            });
            // Capacity is checked before the membership-elsewhere conflict.
            expect(repo.findCurrentRoom).not.toHaveBeenCalled();
        });

        it("409 ACTIVE_MEMBERSHIP_ELSEWHERE after password and capacity pass", async () => {
            const { service, repo } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            repo.findCurrentRoom.mockResolvedValue({
                id: "room-other",
                room_code: "OTH222",
                is_owner: false,
            });

            expect(await contractOf(join(service, "right-pass"))).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    message:
                        "You are still in room OTH222. Leave it before joining another room.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "room-other",
                        roomCode: "OTH222",
                        isOwner: false,
                    },
                },
            });
            expect(repo.insertParticipant).not.toHaveBeenCalled();
        });

        it("maps a concurrent unique violation to the plain join 409 when no room is found", async () => {
            const { service, repo } = setup();
            repo.lockLiveRoomByCode.mockResolvedValue(liveRoom());
            repo.insertParticipant.mockRejectedValue(
                pgUniqueViolation("idx_one_active_room_per_user"),
            );

            expect(await contractOf(join(service, "right-pass"))).toEqual({
                status: HttpStatus.CONFLICT,
                body: {
                    statusCode: 409,
                    error: "Conflict",
                    message:
                        "You already belong to an active watch room. Leave that room before joining another one.",
                },
            });
        });
    });

    describe("leaveRoomSession", () => {
        it("owner leave terminates the room and returns the members to kick", async () => {
            const { service, repo, outbox } = setup();
            repo.lockUserLiveSession.mockResolvedValue({
                room_id: "room-1",
                room_code: "ABC123",
                owner_id: OWNER,
            });
            repo.listActiveMemberUserIds.mockResolvedValue([OWNER, USER]);

            expect(await service.leaveRoomSession(OWNER, "room-1")).toEqual({
                status: "ROOM_DESTROYED",
                roomCode: "ABC123",
                roomId: "room-1",
                membersToKick: [OWNER, USER],
                participantCount: 0,
            });
            expect(repo.lockUserLiveSession).toHaveBeenCalledWith(
                TX,
                OWNER,
                "room-1",
            );
            expect(repo.markRoomTerminating).toHaveBeenCalledWith(TX, "room-1");
            expect(outbox.enqueueRoomReconciliation).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
            expect(repo.deactivateAllRoomParticipants).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
        });

        it("participant leave deactivates only that membership", async () => {
            const { service, repo, outbox } = setup();
            repo.lockUserLiveSession.mockResolvedValue({
                room_id: "room-1",
                room_code: "ABC123",
                owner_id: OWNER,
            });
            repo.countActiveParticipants.mockResolvedValue(1);

            expect(await service.leaveRoomSession(USER)).toEqual({
                status: "PARTICIPANT_EVICTED",
                roomCode: "ABC123",
                roomId: "room-1",
                participantCount: 1,
            });
            expect(repo.deactivateUserMembership).toHaveBeenCalledWith(
                TX,
                "room-1",
                USER,
            );
            expect(repo.incrementRoomStateVersion).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
            expect(outbox.enqueueRoomReconciliation).toHaveBeenCalled();
            expect(repo.markRoomTerminating).not.toHaveBeenCalled();
        });

        it("NO_ACTIVE_SESSION when the user is in no live room", async () => {
            const { service, repo } = setup();
            repo.lockUserLiveSession.mockResolvedValue(undefined);

            expect(await service.leaveRoomSession(USER)).toEqual({
                status: "NO_ACTIVE_SESSION",
            });
            expect(repo.findRoomLifecycle).not.toHaveBeenCalled();
        });

        it.each(["TERMINATING", "TERMINATED"])(
            "ROOM_ALREADY_TERMINATING for the owner's %s room so a retry can finish cleanup",
            async (lifecycle_status) => {
                const { service, repo } = setup();
                repo.lockUserLiveSession.mockResolvedValue(undefined);
                repo.findRoomLifecycle.mockResolvedValue({
                    room_id: "room-1",
                    room_code: "ABC123",
                    owner_id: OWNER,
                    lifecycle_status,
                });

                expect(await service.leaveRoomSession(OWNER, "room-1")).toEqual(
                    {
                        status: "ROOM_ALREADY_TERMINATING",
                        roomCode: "ABC123",
                        roomId: "room-1",
                        participantCount: 0,
                    },
                );
            },
        );

        it("NO_ACTIVE_SESSION for a terminating room the user does not own", async () => {
            const { service, repo } = setup();
            repo.lockUserLiveSession.mockResolvedValue(undefined);
            repo.findRoomLifecycle.mockResolvedValue({
                room_id: "room-1",
                room_code: "ABC123",
                owner_id: OWNER,
                lifecycle_status: "TERMINATING",
            });

            expect(await service.leaveRoomSession(USER, "room-1")).toEqual({
                status: "NO_ACTIVE_SESSION",
            });
        });
    });

    describe("disassociateParticipant (grace expiry)", () => {
        it("returns null when the membership no longer exists", async () => {
            const { service, repo } = setup();
            repo.findParticipantRoomId.mockResolvedValue(undefined);

            expect(await service.disassociateParticipant("part-1")).toBeNull();
            expect(repo.lockRoomStatus).not.toHaveBeenCalled();
        });

        it.each([
            ["the room is gone", undefined],
            ["the room is not ACTIVE", { id: "room-1", room_code: "ABC123", lifecycle_status: "TERMINATING" }],
        ])("returns null when %s", async (_label, room) => {
            const { service, repo } = setup();
            repo.findParticipantRoomId.mockResolvedValue("room-1");
            repo.lockRoomStatus.mockResolvedValue(room);

            expect(await service.disassociateParticipant("part-1")).toBeNull();
            expect(repo.deactivateParticipant).not.toHaveBeenCalled();
        });

        it("returns null when the row was already inactive", async () => {
            const { service, repo, outbox } = setup();
            repo.findParticipantRoomId.mockResolvedValue("room-1");
            repo.lockRoomStatus.mockResolvedValue({
                id: "room-1",
                room_code: "ABC123",
                lifecycle_status: "ACTIVE",
            });
            repo.deactivateParticipant.mockResolvedValue(false);

            expect(await service.disassociateParticipant("part-1")).toBeNull();
            expect(outbox.enqueueRoomReconciliation).not.toHaveBeenCalled();
        });

        it("deactivates, bumps the version and enqueues reconciliation", async () => {
            const { service, repo, outbox } = setup();
            repo.findParticipantRoomId.mockResolvedValue("room-1");
            repo.lockRoomStatus.mockResolvedValue({
                id: "room-1",
                room_code: "ABC123",
                lifecycle_status: "ACTIVE",
            });
            repo.deactivateParticipant.mockResolvedValue(true);
            repo.countActiveParticipants.mockResolvedValue(2);

            expect(await service.disassociateParticipant("part-1")).toEqual({
                roomId: "room-1",
                roomCode: "ABC123",
                participantCount: 2,
            });
            expect(repo.deactivateParticipant).toHaveBeenCalledWith(
                TX,
                "part-1",
                "room-1",
            );
            expect(repo.incrementRoomStateVersion).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
            expect(outbox.enqueueRoomReconciliation).toHaveBeenCalledWith(
                TX,
                "room-1",
            );
        });
    });

    describe("queries", () => {
        it("assertRoomActive: 409 when the room stopped accepting participants", async () => {
            const { service, repo } = setup();
            repo.isRoomActive.mockResolvedValue(false);

            expect(await contractOf(service.assertRoomActive("room-1"))).toEqual(
                {
                    status: HttpStatus.CONFLICT,
                    body: {
                        statusCode: 409,
                        error: "Conflict",
                        message:
                            "The watch room is no longer accepting participants.",
                    },
                },
            );
        });

        it("getRoomDetailsByCode normalizes the code and returns null when missing", async () => {
            const { service, repo } = setup();
            repo.findActiveRoomDetailsByCode.mockResolvedValue(undefined);

            expect(await service.getRoomDetailsByCode(" abc123 ")).toBeNull();
            expect(repo.findActiveRoomDetailsByCode).toHaveBeenCalledWith(
                "ABC123",
            );
        });

        it("listActiveMemberships maps rows and derives isOwner", async () => {
            const { service, repo } = setup();
            repo.listActiveMemberships.mockResolvedValue([
                {
                    participant_id: "p1",
                    room_id: "room-1",
                    room_code: "ABC123",
                    user_id: OWNER,
                    owner_id: OWNER,
                },
                {
                    participant_id: "p2",
                    room_id: "room-1",
                    room_code: "ABC123",
                    user_id: USER,
                    owner_id: OWNER,
                },
            ]);

            expect(await service.listActiveMemberships()).toEqual([
                {
                    participantId: "p1",
                    roomId: "room-1",
                    roomCode: "ABC123",
                    userId: OWNER,
                    isOwner: true,
                },
                {
                    participantId: "p2",
                    roomId: "room-1",
                    roomCode: "ABC123",
                    userId: USER,
                    isOwner: false,
                },
            ]);
        });

        it("getRoomProjectionState stringifies the state version", async () => {
            const { service, repo } = setup();
            repo.findRoomProjection.mockResolvedValue({
                id: "room-1",
                room_code: "ABC123",
                owner_id: OWNER,
                movie_id: MOVIE,
                max_participants: 5,
                lifecycle_status: "ACTIVE",
                state_version: 12,
                participant_count: 3,
            });

            expect(await service.getRoomProjectionState("room-1")).toEqual({
                roomId: "room-1",
                roomCode: "ABC123",
                ownerId: OWNER,
                movieId: MOVIE,
                maxParticipants: 5,
                lifecycleStatus: "ACTIVE",
                stateVersion: "12",
                participantCount: 3,
            });
        });
    });
});
