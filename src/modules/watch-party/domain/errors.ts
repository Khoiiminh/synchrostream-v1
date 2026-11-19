/*
 * Watch-party domain errors. They say what rule was broken, never how it is
 * transported: presentation/error-mapper.ts turns each one into the exact
 * HTTP exception clients already receive.
 *
 * `message` is the user-facing text and is part of the client contract
 * (pinned by watch-party.service.contract.spec.ts). Change it deliberately.
 */

export abstract class WatchPartyDomainError extends Error {
    abstract readonly kind: WatchPartyDomainErrorKind;

    protected constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export type WatchPartyDomainErrorKind =
    | "ROOM_PASSWORD_POLICY"
    | "OWNER_ALREADY_HAS_ROOM"
    | "MEMBER_OF_ANOTHER_ROOM"
    | "ALREADY_IN_ACTIVE_ROOM"
    | "ROOM_CODE_TAKEN"
    | "INVALID_JOIN_IDENTITY"
    | "ROOM_STILL_PROVISIONING"
    | "ROOM_NOT_FOUND"
    | "ROOM_PASSWORD_REQUIRED"
    | "WRONG_ROOM_PASSWORD"
    | "ROOM_FULL"
    | "ROOM_NOT_ACCEPTING_PARTICIPANTS"
    | "PLAYBACK_NOT_PERMITTED";

/** Creation: the password does not meet the room password policy. */
export class RoomPasswordPolicyViolation extends WatchPartyDomainError {
    readonly kind = "ROOM_PASSWORD_POLICY";
    constructor(minLength: number, maxLength: number) {
        super(
            `A room password of ${minLength}-${maxLength} characters is required.`,
        );
    }
}

/** Creation: the owner already has a PROVISIONING or ACTIVE room. */
export class OwnerAlreadyHasRoom extends WatchPartyDomainError {
    readonly kind = "OWNER_ALREADY_HAS_ROOM";
    constructor(
        readonly roomId: string,
        readonly roomCode: string,
    ) {
        super(
            `You already have an active room (${roomCode}). Close it before creating another room.`,
        );
    }
}

/**
 * Create or join: the user still occupies another live room. The client
 * offers "leave it and continue" and retries with `leaveCurrent: true`.
 */
export class MemberOfAnotherRoom extends WatchPartyDomainError {
    readonly kind = "MEMBER_OF_ANOTHER_ROOM";
    constructor(
        readonly roomId: string,
        readonly roomCode: string,
        readonly isOwner: boolean,
    ) {
        super(
            isOwner
                ? `You are still hosting room ${roomCode}. Leaving it will close it for everyone.`
                : `You are still in room ${roomCode}. Leave it before joining another room.`,
        );
    }
}

/**
 * Create or join lost a race on "one live room per user" and the room that
 * won can no longer be identified.
 */
export class AlreadyInActiveRoom extends WatchPartyDomainError {
    readonly kind = "ALREADY_IN_ACTIVE_ROOM";
    constructor(readonly during: "create" | "join") {
        super(
            during === "create"
                ? "You already belong to an active watch room."
                : "You already belong to an active watch room. Leave that room before joining another one.",
        );
    }
}

/** Creation: the room code is reserved by another room. */
export class RoomCodeTaken extends WatchPartyDomainError {
    readonly kind = "ROOM_CODE_TAKEN";
    /** `requestedCode` is null when every server-generated code collided. */
    constructor(readonly requestedCode: string | null) {
        super(
            requestedCode
                ? `Room code ${requestedCode} is already in use. Choose another code.`
                : "Could not allocate a unique room code. Please try again.",
        );
    }
}

/** Join: the caller has no valid authenticated user id. */
export class InvalidJoinIdentity extends WatchPartyDomainError {
    readonly kind = "INVALID_JOIN_IDENTITY";
    constructor() {
        super("An authenticated user UUID is required to join a room.");
    }
}

/** Join: the room is committed but not yet ACTIVE. Retryable. */
export class RoomStillProvisioning extends WatchPartyDomainError {
    readonly kind = "ROOM_STILL_PROVISIONING";
    constructor() {
        super("The watch room is still being prepared. Retrying shortly.");
    }
}

/** Join: no live room has this code. */
export class RoomNotFound extends WatchPartyDomainError {
    readonly kind = "ROOM_NOT_FOUND";
    constructor() {
        super(
            "Handshake rejected: No matching active room stream code sequence.",
        );
    }
}

/** Join: first entry with an empty or blank password. */
export class RoomPasswordRequired extends WatchPartyDomainError {
    readonly kind = "ROOM_PASSWORD_REQUIRED";
    constructor() {
        super(
            "This room is password protected. Enter the room password to join.",
        );
    }
}

/** Join: first entry with the wrong password. */
export class WrongRoomPassword extends WatchPartyDomainError {
    readonly kind = "WRONG_ROOM_PASSWORD";
    constructor() {
        super(
            "Security credentials verification failure: Authentication rejected.",
        );
    }
}

/** Join or runtime registration: the room is at capacity. */
export class RoomFull extends WatchPartyDomainError {
    readonly kind = "ROOM_FULL";
    constructor(readonly capacity: number) {
        super(`Room capacity overflow limit reached. Cap: ${capacity}`);
    }
}

/** The room is no longer ACTIVE, so it takes no more participants. */
export class RoomNotAcceptingParticipants extends WatchPartyDomainError {
    readonly kind = "ROOM_NOT_ACCEPTING_PARTICIPANTS";
    constructor() {
        super("The watch room is no longer accepting participants.");
    }
}

/** Playback: only the owner controls playback. */
export class PlaybackNotPermitted extends WatchPartyDomainError {
    readonly kind = "PLAYBACK_NOT_PERMITTED";
    constructor() {
        super(
            "Playback control rejected: only the room owner can control playback.",
        );
    }
}
