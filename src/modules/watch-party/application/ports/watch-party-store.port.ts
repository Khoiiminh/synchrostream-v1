import type {
    ActiveMembershipRow,
    CreatedRoomRow,
    CurrentRoomRow,
    InactiveRoomRow,
    LockedRoomRow,
    OwnedRoomRow,
    ParticipantRow,
    RoomDetails,
    RoomProjectionRow,
    RoomStatusRow,
    UserSessionRow,
} from "../../watch-party.types.js";
import type { Tx } from "./transaction.js";

/**
 * Persistence for rooms and memberships, as the watch-party use cases need it.
 * Implemented by infrastructure/persistence/watch-party.repository.ts.
 *
 * Locking is part of the contract: `acquireOwnerRoomCreationLock` serializes
 * one owner's creates, and the `lock*` methods hold row locks until the
 * transaction ends.
 *
 * Unique-constraint violations surface as the conflicts in store-errors.ts,
 * never as driver errors.
 */
export interface WatchPartyStore {
    withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

    // Creation
    acquireOwnerRoomCreationLock(tx: Tx, ownerId: string): Promise<void>;
    findOwnedLiveRoom(tx: Tx, ownerId: string): Promise<OwnedRoomRow | undefined>;
    deactivateMembershipsInTerminatedRooms(tx: Tx, userId: string): Promise<void>;
    /** @throws RoomCodeConflict when the code is held by a non-TERMINATED room. */
    insertProvisioningRoom(tx: Tx, room: NewRoom): Promise<CreatedRoomRow>;
    /** @throws ActiveMembershipConflict when the owner already has an active membership. */
    insertOwnerParticipant(tx: Tx, roomId: string, ownerId: string): Promise<void>;

    // Join
    lockLiveRoomByCode(tx: Tx, roomCode: string): Promise<LockedRoomRow | undefined>;
    findActiveParticipant(
        tx: Tx,
        roomId: string,
        userId: string,
    ): Promise<ParticipantRow | undefined>;
    countActiveParticipants(tx: Tx, roomId: string): Promise<number>;
    /** @throws ActiveMembershipConflict when the user already has an active membership. */
    insertParticipant(tx: Tx, roomId: string, userId: string): Promise<ParticipantRow>;
    incrementActiveRoomStateVersion(tx: Tx, roomId: string): Promise<string>;

    // Leave and grace expiry
    findParticipantRoomId(tx: Tx, participantId: string): Promise<string | undefined>;
    lockRoomStatus(tx: Tx, roomId: string): Promise<RoomStatusRow | undefined>;
    deactivateParticipant(
        tx: Tx,
        participantId: string,
        roomId: string,
    ): Promise<number | null>;
    incrementRoomStateVersion(tx: Tx, roomId: string): Promise<void>;
    lockUserLiveSession(
        tx: Tx,
        userId: string,
        roomId?: string,
    ): Promise<UserSessionRow | undefined>;
    findRoomLifecycle(tx: Tx, roomId: string): Promise<InactiveRoomRow | undefined>;
    listActiveMemberUserIds(tx: Tx, roomId: string): Promise<string[]>;
    markRoomTerminating(tx: Tx, roomId: string): Promise<void>;
    deactivateAllRoomParticipants(tx: Tx, roomId: string): Promise<void>;
    deactivateUserMembership(tx: Tx, roomId: string, userId: string): Promise<void>;

    // Queries
    findCurrentRoom(
        tx: Tx | undefined,
        userId: string,
        excludeRoomId?: string,
    ): Promise<CurrentRoomRow | undefined>;
    findActiveRoomDetailsByCode(roomCode: string): Promise<RoomDetails | undefined>;
    isRoomActive(roomId: string): Promise<boolean>;
    listActiveMemberships(): Promise<ActiveMembershipRow[]>;
    findRoomProjection(roomId: string): Promise<RoomProjectionRow | undefined>;
}

export interface NewRoom {
    roomCode: string;
    /** bcrypt hash; the plaintext room password is never stored. */
    passwordHash: string;
    ownerId: string;
    movieId: string;
    maxParticipants: number;
}
