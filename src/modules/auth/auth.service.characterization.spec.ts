import {
    ConflictException,
    HttpException,
    Logger,
    NotFoundException,
    UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service.js";
import type { AuthRepository } from "./auth.repository.js";
import type { JwtService } from "@nestjs/jwt";
import type { RedisBlacklistProvider } from "@/shared/infrastructure/cache/redis-blacklist.provider.js";
import {
    AttemptLimiter,
    LOGIN_RULE,
} from "@/shared/infrastructure/cache/attempt-limiter.js";

jest.mock("../../common/logging/logger.js", () => ({
    maskEmail: (email: string) => email,
}));

/*
 * Characterization of AuthService (plan B4), before its rules move into
 * domain/: registration, login (attempt limiting, token lifetime by role),
 * logout (blacklist for the token's remaining life) and profile lookup.
 */

const USER = {
    id: "u1",
    username: "neo",
    email: "neo@example.test",
    role: "USER",
};

function setup() {
    const accounts = {
        existsByEmailOrUsername: jest.fn().mockResolvedValue(false),
        createUser: jest.fn().mockResolvedValue("u1"),
        findCredentialsByEmail: jest.fn(),
        findProfileById: jest.fn(),
    };
    const jwt = {
        sign: jest.fn().mockReturnValue("signed.jwt"),
        decode: jest.fn(),
    };
    const blacklist = { add: jest.fn().mockResolvedValue(undefined) };
    const limiter = {
        assertAllowed: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
        reset: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
        accounts as unknown as AuthRepository,
        jwt as unknown as JwtService,
        blacklist as unknown as RedisBlacklistProvider,
        limiter as unknown as AttemptLimiter,
    );
    return { service, accounts, jwt, blacklist, limiter };
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

beforeEach(() => {
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe("register", () => {
    it("stores a bcrypt hash (cost 10) and returns the new id", async () => {
        const ctx = setup();
        const result = await ctx.service.register({
            username: "neo",
            email: "neo@example.test",
            password: "secret-pass",
        });

        expect(result).toEqual({
            message: "Success: Account Created",
            userId: "u1",
        });
        const [name, email, stored] = ctx.accounts.createUser.mock.calls[0] as [
            string,
            string,
            string,
        ];
        expect([name, email]).toEqual(["neo", "neo@example.test"]);
        expect(stored.slice(0, 7)).toBe("$2b$10$");
        await expect(bcrypt.compare("secret-pass", stored)).resolves.toBe(true);
    });

    it("an existing email or username is 409", async () => {
        const ctx = setup();
        ctx.accounts.existsByEmailOrUsername.mockResolvedValue(true);

        await expectHttp(
            ctx.service.register({
                username: "neo",
                email: "neo@example.test",
                password: "x",
            }),
            ConflictException,
            409,
            "Account already exists",
        );
        expect(ctx.accounts.existsByEmailOrUsername).toHaveBeenCalledWith(
            "neo@example.test",
            "neo",
        );
        expect(ctx.accounts.createUser).not.toHaveBeenCalled();
    });
});

describe("login", () => {
    async function withPassword(ctx: ReturnType<typeof setup>, role = "USER") {
        ctx.accounts.findCredentialsByEmail.mockResolvedValue({
            ...USER,
            role,
            password_hash: await bcrypt.hash("right", 4),
        });
    }

    it.each([
        ["USER", "7d"],
        ["ADMIN", "1h"],
    ])(
        "a %s gets a %s token and the attempt counter is reset",
        async (role, expiresIn) => {
            const ctx = setup();
            await withPassword(ctx, role);

            const result = await ctx.service.login({
                email: USER.email,
                password: "right",
            });

            expect(result).toEqual({
                user: { ...USER, role },
                access_token: "signed.jwt",
            });
            expect(ctx.jwt.sign).toHaveBeenCalledWith(
                { sub: "u1", username: "neo", role },
                { expiresIn },
            );
            const id = AttemptLimiter.emailId(USER.email);
            expect(ctx.limiter.assertAllowed).toHaveBeenCalledWith(
                LOGIN_RULE,
                id,
            );
            expect(ctx.limiter.reset).toHaveBeenCalledWith(LOGIN_RULE, id);
            expect(ctx.limiter.recordFailure).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["an unknown email", false],
        ["a wrong password", true],
    ])("%s is the same 401, counted as a failure", async (_case, known) => {
        const ctx = setup();
        if (known) await withPassword(ctx);
        else ctx.accounts.findCredentialsByEmail.mockResolvedValue(undefined);

        await expectHttp(
            ctx.service.login({ email: USER.email, password: "wrong" }),
            UnauthorizedException,
            401,
            "Invalid Credentials",
        );
        expect(ctx.limiter.recordFailure).toHaveBeenCalledWith(
            LOGIN_RULE,
            AttemptLimiter.emailId(USER.email),
        );
        expect(ctx.limiter.reset).not.toHaveBeenCalled();
        expect(ctx.jwt.sign).not.toHaveBeenCalled();
    });

    it("a blocked caller is refused before any lookup", async () => {
        const ctx = setup();
        const blocked = new Error("too many");
        ctx.limiter.assertAllowed.mockRejectedValue(blocked);

        await expect(
            ctx.service.login({ email: USER.email, password: "x" }),
        ).rejects.toBe(blocked);
        expect(ctx.accounts.findCredentialsByEmail).not.toHaveBeenCalled();
    });
});

describe("logout", () => {
    const NOW = Date.UTC(2026, 10, 20, 12);

    it("blacklists the token for exactly its remaining lifetime", async () => {
        jest.useFakeTimers({ now: NOW });
        const ctx = setup();
        ctx.jwt.decode.mockReturnValue({ sub: "u1", exp: NOW / 1000 + 90 });

        await expect(ctx.service.logout("tok")).resolves.toEqual({
            message: "Logged out and token revoked",
        });
        expect(ctx.blacklist.add).toHaveBeenCalledWith({
            token: "tok",
            ttl: 90,
        });
    });

    it.each([
        ["already expired", NOW / 1000 - 1],
        ["expiring this second", NOW / 1000],
        ["without exp", undefined],
    ])("a token %s is not blacklisted", async (_case, exp) => {
        jest.useFakeTimers({ now: NOW });
        const ctx = setup();
        ctx.jwt.decode.mockReturnValue({ sub: "u1", exp });

        await expect(ctx.service.logout("tok")).resolves.toEqual({
            message: "Logged out and token revoked",
        });
        expect(ctx.blacklist.add).not.toHaveBeenCalled();
    });

    it("an undecodable token still answers, without revoking", async () => {
        const ctx = setup();
        ctx.jwt.decode.mockReturnValue(null);

        await expect(ctx.service.logout("junk")).resolves.toEqual({
            message: "Logout processed",
        });
        expect(ctx.blacklist.add).not.toHaveBeenCalled();
    });
});

describe("findUserProfileById", () => {
    it("returns the profile row", async () => {
        const ctx = setup();
        ctx.accounts.findProfileById.mockResolvedValue(USER);
        await expect(ctx.service.findUserProfileById("u1")).resolves.toBe(USER);
    });

    it("an unknown user is 404", async () => {
        const ctx = setup();
        ctx.accounts.findProfileById.mockResolvedValue(undefined);
        await expectHttp(
            ctx.service.findUserProfileById("nope"),
            NotFoundException,
            404,
            "The requested user session profile could not be located.",
        );
    });
});
