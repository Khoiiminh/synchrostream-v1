import { RoomPasswordPolicyViolation } from "./errors.js";

/**
 * Every room has its own password; there are no open rooms. An empty password
 * would hash to a valid bcrypt value that a blank join (or an invite link with
 * no password) then matches, so it is rejected at creation and at join.
 */
export const ROOM_PASSWORD_MIN_LENGTH = 4;
export const ROOM_PASSWORD_MAX_LENGTH = 64;

/** At least MIN non-blank characters (after trim), at most MAX in total. */
export function isUsableRoomPassword(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.trim().length >= ROOM_PASSWORD_MIN_LENGTH &&
        value.length <= ROOM_PASSWORD_MAX_LENGTH
    );
}

export function assertUsableRoomPassword(
    value: unknown,
): asserts value is string {
    if (!isUsableRoomPassword(value)) {
        throw new RoomPasswordPolicyViolation(
            ROOM_PASSWORD_MIN_LENGTH,
            ROOM_PASSWORD_MAX_LENGTH,
        );
    }
}

/** A join password that is missing, not a string, or only whitespace. */
export function isBlankPassword(value: unknown): boolean {
    return typeof value !== "string" || value.trim().length === 0;
}
