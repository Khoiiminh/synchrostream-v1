import {
    BadRequestException,
    ConflictException,
    HttpException,
    NotFoundException,
    ServiceUnavailableException,
} from "@nestjs/common";
import { WatchPartyDomainError } from "../domain/errors.js";
import type * as Errors from "../domain/errors.js";

/*
 * Domain error → the exact HTTP exception clients receive today: status,
 * message and, for conflicts, the structured `error` payload the frontend's
 * switch-room prompt reads. Pinned by watch-party.service.contract.spec.ts.
 *
 * Phase 1 calls this at the service boundary so callers still see Nest
 * exceptions. Phase 3 moves the call to the controller and gateway.
 */
export function toHttpException(error: WatchPartyDomainError): HttpException {
    const e = error as AnyDomainError;
    switch (e.kind) {
        case "ROOM_PASSWORD_POLICY":
        case "INVALID_JOIN_IDENTITY":
        case "ROOM_PASSWORD_REQUIRED":
        case "WRONG_ROOM_PASSWORD":
        case "ROOM_FULL":
        case "PLAYBACK_NOT_PERMITTED":
            return new BadRequestException(e.message);

        case "ROOM_NOT_FOUND":
            return new NotFoundException(e.message);

        case "ROOM_STILL_PROVISIONING":
            return new ServiceUnavailableException(e.message);

        case "ALREADY_IN_ACTIVE_ROOM":
        case "ROOM_NOT_ACCEPTING_PARTICIPANTS":
            return new ConflictException(e.message);

        case "OWNER_ALREADY_HAS_ROOM":
            return new ConflictException({
                message: e.message,
                error: {
                    code: "ACTIVE_OWNER_ROOM",
                    roomId: e.roomId,
                    roomCode: e.roomCode,
                    isOwner: true,
                },
            });

        case "MEMBER_OF_ANOTHER_ROOM":
            return new ConflictException({
                message: e.message,
                error: {
                    code: "ACTIVE_MEMBERSHIP_ELSEWHERE",
                    roomId: e.roomId,
                    roomCode: e.roomCode,
                    isOwner: e.isOwner,
                },
            });

        case "ROOM_CODE_TAKEN":
            return new ConflictException({
                message: e.message,
                error: { code: "ROOM_CODE_IN_USE" },
            });

        default: {
            const unhandled: never = e;
            throw new Error(
                `Unmapped watch-party domain error: ${String(unhandled)}`,
            );
        }
    }
}

/** Rethrows a domain error as its HTTP exception; anything else unchanged. */
export function rethrowAsHttp(error: unknown): never {
    if (error instanceof WatchPartyDomainError) throw toHttpException(error);
    throw error;
}

/** Runs `fn`, converting domain errors it throws into HTTP exceptions. */
export async function withHttpErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        rethrowAsHttp(error);
    }
}

type AnyDomainError =
    | Errors.RoomPasswordPolicyViolation
    | Errors.OwnerAlreadyHasRoom
    | Errors.MemberOfAnotherRoom
    | Errors.AlreadyInActiveRoom
    | Errors.RoomCodeTaken
    | Errors.InvalidJoinIdentity
    | Errors.RoomStillProvisioning
    | Errors.RoomNotFound
    | Errors.RoomPasswordRequired
    | Errors.WrongRoomPassword
    | Errors.RoomFull
    | Errors.RoomNotAcceptingParticipants
    | Errors.PlaybackNotPermitted;
