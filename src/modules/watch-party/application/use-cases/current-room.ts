import type { WatchPartyStore } from "../ports/watch-party-store.port.js";
import type { Tx } from "../ports/transaction.js";
import { MemberOfAnotherRoom } from "../../domain/errors.js";

export interface CurrentRoom {
    roomId: string;
    roomCode: string;
    isOwner: boolean;
}

/**
 * The room a user currently occupies, if any: an active membership in a
 * PROVISIONING/ACTIVE room, or a PROVISIONING/ACTIVE room they own.
 * `excludeRoomId` skips the room being joined. `tx` is the open transaction,
 * or `undefined` for the pool.
 */
export async function findCurrentRoom(
    store: WatchPartyStore,
    tx: Tx | undefined,
    userId: string,
    excludeRoomId?: string,
): Promise<CurrentRoom | null> {
    const row = await store.findCurrentRoom(tx, userId, excludeRoomId);
    return row
        ? { roomId: row.id, roomCode: row.room_code, isOwner: row.is_owner }
        : null;
}

/**
 * "You are still in another room". Mapped to the structured 409 the client
 * answers with "leave it and continue" (`leaveCurrent: true`).
 */
export function toMemberOfAnotherRoom(
    current: CurrentRoom,
): MemberOfAnotherRoom {
    return new MemberOfAnotherRoom(
        current.roomId,
        current.roomCode,
        current.isOwner,
    );
}
