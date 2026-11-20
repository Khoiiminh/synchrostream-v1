import {
    accessTokenLifetime,
    remainingLifetimeSeconds,
} from "./access-token.js";

describe("access-token rules", () => {
    it("admins get 1 hour, every other role 7 days", () => {
        expect(accessTokenLifetime("ADMIN")).toBe("1h");
        expect(accessTokenLifetime("USER")).toBe("7d");
        expect(accessTokenLifetime("admin")).toBe("7d");
    });

    it("a token has the seconds left until exp", () => {
        expect(remainingLifetimeSeconds(1_090, 1_000)).toBe(90);
        expect(remainingLifetimeSeconds(1_001, 1_000)).toBe(1);
    });

    it("an expired, expiring or exp-less token has nothing left", () => {
        expect(remainingLifetimeSeconds(1_000, 1_000)).toBeNull();
        expect(remainingLifetimeSeconds(999, 1_000)).toBeNull();
        expect(remainingLifetimeSeconds(undefined, 1_000)).toBeNull();
    });
});
