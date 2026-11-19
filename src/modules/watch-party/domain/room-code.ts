import { randomInt } from "node:crypto";

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Server-generated codes are retried this many times on a collision. */
export const ROOM_CODE_GENERATION_ATTEMPTS = 5;

/** Codes are case-insensitive: stored and compared upper-cased and trimmed. */
export function normalizeRoomCode(code: string): string {
    return code.trim().toUpperCase();
}

export function generateRoomCode(
    pickIndex: (alphabetLength: number) => number = randomInt,
): string {
    let code = "";
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        code += ROOM_CODE_ALPHABET[pickIndex(ROOM_CODE_ALPHABET.length)];
    }
    return code;
}

/**
 * After a code collision: a code the user chose is never swapped for another,
 * a generated one is retried until the attempts run out.
 */
export function shouldRetryRoomCode(p: {
    requestedCode: string | undefined;
    attempt: number;
}): boolean {
    return !p.requestedCode && p.attempt + 1 < ROOM_CODE_GENERATION_ATTEMPTS;
}
