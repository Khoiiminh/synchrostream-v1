import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { PostgresProvider } from "../../src/shared/infrastructure/database/postgres.provider.js";
import { TEST_DATABASE_URL_ENV, assertLocal } from "./database.cjs";

/** The real PostgresProvider, connected to the disposable test database. */
export function connectTestPostgres(): PostgresProvider {
    const url = process.env[TEST_DATABASE_URL_ENV];
    if (!url) throw new Error("Integration global setup did not run.");
    assertLocal(url);

    const config = {
        get: (key: string) => (key === "DATABASE_URL" ? url : undefined),
    } as unknown as ConfigService;
    const pg = new PostgresProvider(config);
    pg.onModuleInit();
    return pg;
}

/** Empties every application table between tests; keeps the migrations table. */
export async function resetDatabase(pg: PostgresProvider): Promise<void> {
    await pg.query(`
        TRUNCATE public.chat_history, public.room_lifecycle_outbox,
                 public.media_sessions, public.room_participants,
                 public.rooms, public.movies, public.sfu_nodes, public.users
        RESTART IDENTITY CASCADE`);
}

export async function insertUser(pg: PostgresProvider, name: string) {
    const result = await pg.query<{ id: string }>(
        `INSERT INTO public.users (username, email, password_hash)
         VALUES ($1, $2, 'not-a-real-hash') RETURNING id`,
        [name, `${name}@example.test`],
    );
    return result.rows[0].id;
}

export async function insertMovie(pg: PostgresProvider) {
    const result = await pg.query<{ id: string }>(
        `INSERT INTO public.movies (title, status) VALUES ('Test movie', 'AVAILABLE') RETURNING id`,
    );
    return result.rows[0].id;
}

export function silenceNestLogger(): void {
    for (const level of ["log", "warn", "error", "debug"] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
}
