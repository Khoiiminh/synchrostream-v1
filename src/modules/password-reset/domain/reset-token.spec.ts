import {
    RESET_REQUEST_ANSWER,
    RESET_TOKEN_BYTES,
    RESET_TOKEN_TTL_MS,
    resetLink,
    resetTokenExpiry,
    resetValidityText,
} from "./reset-token.js";

describe("reset-token rules", () => {
    it("tokens are 32 random bytes valid for one hour", () => {
        expect(RESET_TOKEN_BYTES).toBe(32);
        expect(RESET_TOKEN_TTL_MS).toBe(3_600_000);
        expect(resetTokenExpiry(1_000)).toEqual(new Date(3_601_000));
    });

    it("the email states the validity in minutes, singular for one", () => {
        expect(resetValidityText()).toBe("60 minutes");
        expect(resetValidityText(60_000)).toBe("1 minute");
        expect(resetValidityText(120_000)).toBe("2 minutes");
    });

    it("the link points at the frontend's reset page", () => {
        expect(resetLink("https://app.test", "abc")).toBe(
            "https://app.test/auth/password-reset?token=abc",
        );
    });

    it("the answer never reveals whether the account exists", () => {
        expect(RESET_REQUEST_ANSWER).toEqual({
            message: "If an account exists, a reset link has been sent.",
        });
    });
});
