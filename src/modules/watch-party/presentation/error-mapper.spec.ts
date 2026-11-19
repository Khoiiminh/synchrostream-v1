import { HttpException } from "@nestjs/common";
import * as E from "../domain/errors.js";
import { rethrowAsHttp, toHttpException, withHttpErrors } from "./error-mapper.js";

/*
 * Every domain error's HTTP shape. The service contract spec pins these end
 * to end; this table makes a missing or changed mapping fail in one place.
 */

const body = (error: E.WatchPartyDomainError) => {
    const http = toHttpException(error);
    return { status: http.getStatus(), body: http.getResponse() };
};

const plain = (status: number, error: string, message: string) => ({
    status,
    body: { statusCode: status, error, message },
});

describe("toHttpException", () => {
    it.each<[string, E.WatchPartyDomainError, unknown]>([
        [
            "RoomPasswordPolicyViolation",
            new E.RoomPasswordPolicyViolation(4, 64),
            plain(400, "Bad Request", "A room password of 4-64 characters is required."),
        ],
        [
            "InvalidJoinIdentity",
            new E.InvalidJoinIdentity(),
            plain(400, "Bad Request", "An authenticated user UUID is required to join a room."),
        ],
        [
            "RoomPasswordRequired",
            new E.RoomPasswordRequired(),
            plain(400, "Bad Request", "This room is password protected. Enter the room password to join."),
        ],
        [
            "WrongRoomPassword",
            new E.WrongRoomPassword(),
            plain(400, "Bad Request", "Security credentials verification failure: Authentication rejected."),
        ],
        [
            "RoomFull",
            new E.RoomFull(7),
            plain(400, "Bad Request", "Room capacity overflow limit reached. Cap: 7"),
        ],
        [
            "PlaybackNotPermitted",
            new E.PlaybackNotPermitted(),
            plain(400, "Bad Request", "Playback control rejected: only the room owner can control playback."),
        ],
        [
            "RoomNotFound",
            new E.RoomNotFound(),
            plain(404, "Not Found", "Handshake rejected: No matching active room stream code sequence."),
        ],
        [
            "RoomStillProvisioning",
            new E.RoomStillProvisioning(),
            plain(503, "Service Unavailable", "The watch room is still being prepared. Retrying shortly."),
        ],
        [
            "RoomNotAcceptingParticipants",
            new E.RoomNotAcceptingParticipants(),
            plain(409, "Conflict", "The watch room is no longer accepting participants."),
        ],
        [
            "AlreadyInActiveRoom (create)",
            new E.AlreadyInActiveRoom("create"),
            plain(409, "Conflict", "You already belong to an active watch room."),
        ],
        [
            "AlreadyInActiveRoom (join)",
            new E.AlreadyInActiveRoom("join"),
            plain(
                409,
                "Conflict",
                "You already belong to an active watch room. Leave that room before joining another one.",
            ),
        ],
        [
            "OwnerAlreadyHasRoom",
            new E.OwnerAlreadyHasRoom("r1", "OLD111"),
            {
                status: 409,
                body: {
                    message:
                        "You already have an active room (OLD111). Close it before creating another room.",
                    error: { code: "ACTIVE_OWNER_ROOM", roomId: "r1", roomCode: "OLD111", isOwner: true },
                },
            },
        ],
        [
            "MemberOfAnotherRoom (member)",
            new E.MemberOfAnotherRoom("r2", "OTH222", false),
            {
                status: 409,
                body: {
                    message: "You are still in room OTH222. Leave it before joining another room.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "r2",
                        roomCode: "OTH222",
                        isOwner: false,
                    },
                },
            },
        ],
        [
            "MemberOfAnotherRoom (owner)",
            new E.MemberOfAnotherRoom("r3", "OWN333", true),
            {
                status: 409,
                body: {
                    message:
                        "You are still hosting room OWN333. Leaving it will close it for everyone.",
                    error: {
                        code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                        roomId: "r3",
                        roomCode: "OWN333",
                        isOwner: true,
                    },
                },
            },
        ],
        [
            "RoomCodeTaken (requested)",
            new E.RoomCodeTaken("TAKEN1"),
            {
                status: 409,
                body: {
                    message: "Room code TAKEN1 is already in use. Choose another code.",
                    error: { code: "ROOM_CODE_IN_USE" },
                },
            },
        ],
        [
            "RoomCodeTaken (generated)",
            new E.RoomCodeTaken(null),
            {
                status: 409,
                body: {
                    message: "Could not allocate a unique room code. Please try again.",
                    error: { code: "ROOM_CODE_IN_USE" },
                },
            },
        ],
    ])("%s", (_name, error, expected) => {
        expect(body(error)).toEqual(expected);
    });

    it("the HTTP exception carries the domain message", () => {
        expect(toHttpException(new E.RoomFull(2)).message).toBe(
            "Room capacity overflow limit reached. Cap: 2",
        );
    });
});

describe("withHttpErrors / rethrowAsHttp", () => {
    it("converts a domain error", async () => {
        await expect(
            withHttpErrors(async () => {
                throw new E.RoomNotFound();
            }),
        ).rejects.toBeInstanceOf(HttpException);
    });

    it("passes other errors through unchanged", async () => {
        const boom = new Error("db down");
        await expect(
            withHttpErrors(async () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
        expect(() => rethrowAsHttp(boom)).toThrow(boom);
    });

    it("returns the value on success", async () => {
        await expect(withHttpErrors(async () => 42)).resolves.toBe(42);
    });
});
