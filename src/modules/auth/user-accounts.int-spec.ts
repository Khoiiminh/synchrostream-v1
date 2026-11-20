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
     * reset_expires is timestamptz (migration *_reset_expires_timestamptz), so
     * the offset node-pg sends with a Date is honoured. Before, the offset was
     * dropped and a token lived 1 h plus the server's UTC offset (8 h at
     * UTC+7; already expired west of UTC).
     */
    it.each([
        ["Bangkok", 7],
        ["UTC", 0],
        ["New York", -5],
    ])(
        "an expiry written by a %s server means the same instant",
        async (_zone, offsetHours) => {
            const { auth, reset } = build();
            const id = await auth.createUser("a", "a@x.test", "hash-a");
            // node-pg serializes a Date as local time plus that zone's offset.
            const local = (ms: number) => {
                const shifted = new Date(ms + offsetHours * 3_600_000);
                const sign = offsetHours < 0 ? "-" : "+";
                const hh = String(Math.abs(offsetHours)).padStart(2, "0");
                return `${shifted.toISOString().slice(0, 23)}${sign}${hh}:00`;
            };

            await pg.query(
                "UPDATE public.users SET reset_token = 'gone', reset_expires = $1 WHERE id = $2",
                [local(Date.now() - 60_000), id],
            );
            expect(await reset.findUserIdByResetToken("gone")).toBeUndefined();

            await pg.query(
                "UPDATE public.users SET reset_token = 'good', reset_expires = $1 WHERE id = $2",
                [local(Date.now() + 60_000), id],
            );
            expect(await reset.findUserIdByResetToken("good")).toBe(id);
        },
    );

    it("a Date from this process expires on time", async () => {
        const { auth, reset } = build();
        const id = await auth.createUser("a", "a@x.test", "hash-a");
        await reset.saveResetToken(
            id,
            "just-gone",
            new Date(Date.now() - 60_000),
        );
        expect(await reset.findUserIdByResetToken("just-gone")).toBeUndefined();
        await reset.saveResetToken(id, "fresh", new Date(Date.now() + 60_000));
        expect(await reset.findUserIdByResetToken("fresh")).toBe(id);
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
