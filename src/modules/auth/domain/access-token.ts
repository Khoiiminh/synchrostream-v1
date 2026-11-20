/*
 * Access-token rules. Admins get short sessions; everyone else stays signed
 * in for a week. A revoked token is blacklisted only for the life it has
 * left, so the blacklist never outgrows the tokens it guards.
 */

export type AccessTokenLifetime = "1h" | "7d";

export function accessTokenLifetime(role: string): AccessTokenLifetime {
    return role === "ADMIN" ? "1h" : "7d";
}

/**
 * Seconds a token has left at `nowSeconds`, or null when it has none: it is
 * expired, expires this second, or carries no `exp`.
 */
export function remainingLifetimeSeconds(
    exp: number | undefined,
    nowSeconds: number,
): number | null {
    const ttl = (exp ?? nowSeconds) - nowSeconds;
    return ttl > 0 ? ttl : null;
}
