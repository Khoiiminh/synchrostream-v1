import {
    InvalidJoinIdentity,
    RoomFull,
    RoomNotFound,
    RoomPasswordRequired,
    RoomStillProvisioning,
} from "./errors.js";
import { isBlankPassword } from "./room-password.js";

/*
 * Join rules. The service applies them in this order, which is part of the
 * contract:
 *
 *   1. identity        assertJoinIdentity
 *   2. room state      assertRoomJoinable   (PROVISIONING → 503, none → 404)
 *   3. password        only when isJoinPasswordRequired (owner and reconnect skip it)
 *   4. capacity        assertRoomHasCapacity (new memberships only)
 *   5. other room      MemberOfAnotherRoom, checked last so a client that
 *                      answers it with "leave and switch" never leaves its
 *                      room for a join that would have failed anyway
 */

const USER_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertJoinIdentity(userId: string): void {
    if (!USER_UUID.test(userId)) throw new InvalidJoinIdentity();
}

/** Narrows the locked room row: only an ACTIVE live room can be joined. */
export function assertRoomJoinable<T extends { lifecycle_status: string }>(
    room: T | undefined | null,
): asserts room is T {
    if (room?.lifecycle_status === "PROVISIONING") {
        throw new RoomStillProvisioning();
    }
    if (!room) throw new RoomNotFound();
}

/**
 * The password is checked only on first entry. The owner never needs it, and
 * a user with an ACTIVE membership already proved it when that membership was
 * created, so a reconnect within the grace window is accepted without it. The
 * membership goes inactive on voluntary leave or grace expiry, after which the
 * password is required again.
 */
export function isJoinPasswordRequired(p: {
    isOwner: boolean;
    hasActiveMembership: boolean;
}): boolean {
    return !p.isOwner && !p.hasActiveMembership;
}

/**
 * A blank password never opens a room. Socket payloads skip the HTTP
 * ValidationPipe, so this is checked in the domain. Not a wrong guess.
 */
export function assertJoinPasswordPresent(password: unknown): void {
    if (isBlankPassword(password)) throw new RoomPasswordRequired();
}

export function hasCapacity(p: {
    activeCount: number;
    capacity: number;
}): boolean {
    return p.activeCount < p.capacity;
}

export function assertRoomHasCapacity(p: {
    activeCount: number;
    capacity: number;
}): void {
    if (!hasCapacity(p)) throw new RoomFull(p.capacity);
}
