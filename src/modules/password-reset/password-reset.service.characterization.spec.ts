import {
    BadRequestException,
    HttpException,
    InternalServerErrorException,
    Logger,
} from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { PasswordService } from "./password-reset.service.js";
import type { PasswordResetAccounts as PasswordResetRepository } from "../auth/queries/password-reset-accounts.js";
import {
    AttemptLimiter,
    PASSWORD_RESET_REQUEST_RULE,
} from "@/shared/infrastructure/cache/attempt-limiter.js";

jest.mock("../../common/logging/logger.js", () => ({
    maskEmail: (email: string) => email,
}));

/*
 * Characterization of PasswordService (plan B4), before its rules move into
 * domain/: the reset request (rate limit, no account enumeration, 1-hour
 * token, the email) and the reset itself. The mail transport is replaced.
 */

const EMAIL = "neo@example.test";
const NOW = Date.UTC(2026, 10, 20, 12);

function setup() {
    const accounts = {
        findUserIdByEmail: jest.fn().mockResolvedValue("u1"),
        saveResetToken: jest.fn().mockResolvedValue(undefined),
        findUserIdByResetToken: jest.fn(),
        updatePasswordAndClearToken: jest.fn().mockResolvedValue(undefined),
    };
    const limiter = { consume: jest.fn().mockResolvedValue(undefined) };
    const env: Record<string, string> = {
        FRONTEND_URL: "https://app.example.test",
        MAIL_USER: "support@example.test",
    };
    const config = { get: (key: string) => env[key] } as ConfigService;
    const service = new PasswordService(
        config,
        accounts as unknown as PasswordResetRepository,
        limiter as unknown as AttemptLimiter,
    );
    const sendMail = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(
        service as unknown as { createTransporter: () => Promise<unknown> },
        "createTransporter",
    ).mockResolvedValue({ sendMail });
    return { service, accounts, limiter, sendMail };
}

async function expectHttp(
    promise: Promise<unknown>,
    type: new (...args: never[]) => HttpException,
    status: number,
    message: string,
) {
    const error: unknown = await promise.then(
        () => {
            throw new Error("expected a rejection");
        },
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(type);
    expect((error as HttpException).getStatus()).toBe(status);
    expect((error as HttpException).message).toBe(message);
}

const GENERIC = {
    message: "If an account exists, a reset link has been sent.",
};

beforeEach(() => {
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe("requestReset", () => {
    it("saves a random 64-hex token valid for one hour and mails the link", async () => {
        jest.useFakeTimers({ now: NOW });
        const ctx = setup();

        await expect(
            ctx.service.requestReset({ email: EMAIL }),
        ).resolves.toEqual(GENERIC);

        expect(ctx.limiter.consume).toHaveBeenCalledWith(
            PASSWORD_RESET_REQUEST_RULE,
            AttemptLimiter.emailId(EMAIL),
        );
        const [userId, token, expiresAt] = ctx.accounts.saveResetToken.mock
            .calls[0] as [string, string, Date];
        expect(userId).toBe("u1");
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(expiresAt).toEqual(new Date(NOW + 3_600_000));

        const [mail] = ctx.sendMail.mock.calls[0] as [
            { from: string; to: string; subject: string; html: string },
        ];
        expect(mail.from).toBe(
            '"SynchroStream Support" <support@example.test>',
        );
        expect(mail.to).toBe(EMAIL);
        expect(mail.subject).toBe("Password Reset Request");
        expect(mail.html).toContain(
            `href="https://app.example.test/auth/password-reset?token=${token}"`,
        );
        expect(mail.html).toContain(
            "This verification is valid for 60 minutes.",
        );
    });

    it("two requests get different tokens", async () => {
        const ctx = setup();
        await ctx.service.requestReset({ email: EMAIL });
        await ctx.service.requestReset({ email: EMAIL });
        const tokens = (
            ctx.accounts.saveResetToken.mock.calls as unknown[][]
        ).map((c) => c[1]);
        expect(tokens[0]).not.toBe(tokens[1]);
    });

    it("an unknown email gets the same answer, counts, and sends nothing", async () => {
        const ctx = setup();
        ctx.accounts.findUserIdByEmail.mockResolvedValue(undefined);

        await expect(
            ctx.service.requestReset({ email: EMAIL }),
        ).resolves.toEqual(GENERIC);
        expect(ctx.limiter.consume).toHaveBeenCalled();
        expect(ctx.accounts.saveResetToken).not.toHaveBeenCalled();
        expect(ctx.sendMail).not.toHaveBeenCalled();
    });

    it("a rate-limited caller is refused before the lookup", async () => {
        const ctx = setup();
        const limited = new Error("slow down");
        ctx.limiter.consume.mockRejectedValue(limited);

        await expect(ctx.service.requestReset({ email: EMAIL })).rejects.toBe(
            limited,
        );
        expect(ctx.accounts.findUserIdByEmail).not.toHaveBeenCalled();
    });

    it("a mail failure is 500 after the token was saved", async () => {
        const ctx = setup();
        ctx.sendMail.mockRejectedValue(new Error("smtp"));

        await expectHttp(
            ctx.service.requestReset({ email: EMAIL }),
            InternalServerErrorException,
            500,
            "Error sending email",
        );
        expect(ctx.accounts.saveResetToken).toHaveBeenCalled();
    });
});

describe("resetPassword", () => {
    it("stores a bcrypt hash (cost 10) and clears the token", async () => {
        const ctx = setup();
        ctx.accounts.findUserIdByResetToken.mockResolvedValue("u1");

        await expect(
            ctx.service.resetPassword({ token: "t", newPassword: "new-pass" }),
        ).resolves.toEqual({
            message: "Password updated successfully",
            userId: "u1",
        });
        expect(ctx.accounts.findUserIdByResetToken).toHaveBeenCalledWith("t");
        const [userId, stored] = ctx.accounts.updatePasswordAndClearToken.mock
            .calls[0] as [string, string];
        expect(userId).toBe("u1");
        expect(stored.slice(0, 7)).toBe("$2b$10$");
        await expect(bcrypt.compare("new-pass", stored)).resolves.toBe(true);
    });

    it("an unknown or expired token is 400", async () => {
        const ctx = setup();
        ctx.accounts.findUserIdByResetToken.mockResolvedValue(undefined);

        await expectHttp(
            ctx.service.resetPassword({ token: "t", newPassword: "x" }),
            BadRequestException,
            400,
            "Invalid or expired token",
        );
        expect(ctx.accounts.updatePasswordAndClearToken).not.toHaveBeenCalled();
    });
});
