/*
 * Password-reset tokens: random, single use, valid for one hour. The answer
 * to a reset request is the same whether or not the account exists.
 */

export const RESET_TOKEN_TTL_MS = 3_600_000;

/** Random bytes per token; hex-encoded, so 64 characters. */
export const RESET_TOKEN_BYTES = 32;

export const RESET_REQUEST_ANSWER = {
    message: "If an account exists, a reset link has been sent.",
} as const;

export function resetTokenExpiry(now: number): Date {
    return new Date(now + RESET_TOKEN_TTL_MS);
}

/** "60 minutes", "1 minute": how long the emailed link works. */
export function resetValidityText(ttlMs: number = RESET_TOKEN_TTL_MS): string {
    const minutes = ttlMs / 1000 / 60;
    return `${minutes} ${minutes > 1 ? "minutes" : "minute"}`;
}

export function resetLink(
    frontendUrl: string | undefined,
    token: string,
): string {
    return `${frontendUrl}/auth/password-reset?token=${token}`;
}
