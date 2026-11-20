import type { PostgresProvider } from "@/shared/infrastructure/database/postgres.provider.js";
import { AuthRepository } from "./auth.repository.js";
import { PasswordResetAccounts } from "./queries/password-reset-accounts.js";
import {
    connectTestPostgres,
    resetDatabase,
} from "../../../test/integration/fixtures.js";

/*
 * Characterization of every statement on `users` (plan B4): sign-up and
 * sign-in reads, and the password-reset token flow, on the disposable
 * Postgres. Only build() knows which classes hold the SQL.
 */

let pg: PostgresProvider;

beforeAll(() => {
    pg = connectTestPostgres();
});
afterAll(async () => {
    await pg.onModuleDestroy();
});
beforeEach(async () => {
    await resetDatabase(pg);
});

function build() {
    return {
        auth: new AuthRepository(pg),
        reset: new PasswordResetAccounts(pg),
    };
}

async function row(id: string) {
    const { rows } = await pg.query<{
        password_hash: string;
        reset_token: string | null;
        reset_expires: Date | null;
        role: string;
    }>(
        `SELECT password_hash, reset_token, reset_expires, role FROM public.users WHERE id = $1`,
        [id],
    );
    return rows[0];
}

describe("sign-up and sign-in", () => {
    it("creates a USER and finds it by email or username", async () => {
        const { auth } = build();

        expect(await auth.existsByEmailOrUsername("a@x.test", "a")).toBe(false);
        const id = await auth.createUser("a", "a@x.test", "hash-a");

        expect(await auth.existsByEmailOrUsername("a@x.test", "other")).toBe(
            true,
        );
        expect(await auth.existsByEmailOrUsername("other@x.test", "a")).toBe(
            true,
        );
        expect(await auth.findCredentialsByEmail("a@x.test")).toEqual({
            id,
            username: "a",
            email: "a@x.test",
            password_hash: "hash-a",
            role: "USER",
        });
        expect(await auth.findProfileById(id)).toEqual({
            id,
            username: "a",
            email: "a@x.test",
            role: "USER",
        });
    });

    it("unknown users are undefined", async () => {
        const { auth } = build();
        expect(
            await auth.findCredentialsByEmail("none@x.test"),
        ).toBeUndefined();
        expect(
            await auth.findProfileById("00000000-0000-4000-8000-000000000000"),
        ).toBeUndefined();
    });
});

describe("password reset", () => {
    /*
     * KNOWN BUG, pinned as failing (plan B4 note): reset_expires is
     * `timestamp` without a time zone, and node-pg sends a Date as local time
     * with an offset, which Postgres drops on that column. A token therefore
     * lives 1 h plus the app server's UTC offset (8 h at UTC+7; already
     * expired west of UTC). Correct only when the app runs at UTC. When this
     * is fixed, this test starts passing and `it.failing` reports it.
     */
    it.failing("an expiry one minute ago is already expired", async () => {
        const { auth, reset } = build();
        const id = await auth.createUser("a", "a@x.test", "hash-a");
        await reset.saveResetToken(
            id,
            "just-gone",
            new Date(Date.now() - 60_000),
        );
        expect(await reset.findUserIdByResetToken("just-gone")).toBeUndefined();
    });

    it("a saved token finds its user until it expires", async () => {
        const { auth, reset } = build();
        const id = await auth.createUser("a", "a@x.test", "hash-a");
        expect(await reset.findUserIdByEmail("a@x.test")).toBe(id);
        expect(await reset.findUserIdByEmail("none@x.test")).toBeUndefined();

        await reset.saveResetToken(
            id,
            "live",
            new Date(Date.now() + 3_600_000),
        );
        expect(await reset.findUserIdByResetToken("live")).toBe(id);
        expect(await reset.findUserIdByResetToken("other")).toBeUndefined();

        await reset.saveResetToken(
            id,
            "stale",
            new Date(Date.now() - 2 * 24 * 3_600_000),
        );
        expect(await reset.findUserIdByResetToken("stale")).toBeUndefined();
        // Saving replaces the previous token.
        expect(await reset.findUserIdByResetToken("live")).toBeUndefined();
    });

    it("updating the password clears the token, so it works once", async () => {
        const { auth, reset } = build();
        const id = await auth.createUser("a", "a@x.test", "hash-a");
        await reset.saveResetToken(
            id,
            "once",
            new Date(Date.now() + 3_600_000),
        );

        await reset.updatePasswordAndClearToken(id, "hash-b");

        expect(await row(id)).toMatchObject({
            password_hash: "hash-b",
            reset_token: null,
            reset_expires: null,
        });
        expect(await reset.findUserIdByResetToken("once")).toBeUndefined();
    });
});
