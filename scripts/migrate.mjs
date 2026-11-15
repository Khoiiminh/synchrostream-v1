#!/usr/bin/env node
// SynchroStream database migrations (node-pg-migrate with plain .sql files).
//
//   npm run migrate:status            list applied and pending migrations
//   npm run migrate:create -- <name>  create migrations/<UTC timestamp>_<name>.sql
//   npm run migrate:up                apply all pending migrations
//   npm run migrate:down -- --yes     roll back the most recent migration
//   npm run migrate:baseline          mark the baseline as applied on an existing database
//
// Connection: DATABASE_URL and the optional DB_CA_CERT (PEM), same as the backend.
// The npm scripts load .env.development when it exists; in deployed environments
// the variables come from the platform instead.

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const MIGRATIONS_TABLE = "pgmigrations";
const BASELINE_PATTERN = /^\d{17}_baseline_/;

// Fail fast instead of queueing behind live traffic when a migration needs a busy table.
const LOCK_TIMEOUT = process.env.MIGRATE_LOCK_TIMEOUT ?? "10s";

function connectionConfig() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error(
            "DATABASE_URL is not set (expected in .env.development or the environment).",
        );
    }
    const ca = process.env.DB_CA_CERT;
    return {
        connectionString,
        ssl: ca ? { rejectUnauthorized: true, ca: [ca] } : undefined,
        options: `-c lock_timeout=${LOCK_TIMEOUT}`,
        application_name: "synchrostream-migrate",
    };
}

async function migrationFiles() {
    const files = await readdir(MIGRATIONS_DIR);
    return files.filter((f) => f.endsWith(".sql")).sort();
}

async function appliedMigrations(client) {
    const { rows } = await client.query("SELECT to_regclass($1) AS t", [
        `public.${MIGRATIONS_TABLE}`,
    ]);
    if (!rows[0].t) return new Map();
    // run_on is `timestamp` without a time zone, written in the server's time zone;
    // read it as text so the client's local offset is not applied to it.
    const res = await client.query(
        `SELECT name, to_char(run_on, 'YYYY-MM-DD HH24:MI:SS') || ' ' || current_setting('TimeZone') AS run_on
         FROM public.${MIGRATIONS_TABLE} ORDER BY run_on, id`,
    );
    return new Map(res.rows.map((r) => [r.name, r.run_on]));
}

async function withClient(fn) {
    const client = new pg.Client(connectionConfig());
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

function run(options) {
    const config = connectionConfig();
    return runner({
        // node-pg-migrate accepts a connection string for databaseUrl, but we also
        // preserve the custom pg config (SSL, lock_timeout, app name) for the runner.
        ...config,
        databaseUrl: config.connectionString,
        dbClient: pg,
        dir: MIGRATIONS_DIR,
        migrationsTable: MIGRATIONS_TABLE,
        checkOrder: true,
        singleTransaction: true,
        advisoryLockMode: "wait",
        ...options,
    });
}

async function status() {
    const files = await migrationFiles();
    const applied = await withClient(appliedMigrations);
    let pending = 0;
    for (const file of files) {
        const name = file.replace(/\.sql$/, "");
        const runOn = applied.get(name);
        if (!runOn) pending += 1;
        console.log(
            `${runOn ? "applied " : "PENDING "} ${name}${runOn ? `  (${runOn})` : ""}`,
        );
        applied.delete(name);
    }
    for (const name of applied.keys()) {
        console.log(
            `MISSING  ${name}  (recorded in the database, but no file in migrations/)`,
        );
    }
    console.log(`\n${pending} pending`);
}

async function create(rawName) {
    const slug = (rawName ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    if (!slug)
        throw new Error("Usage: npm run migrate:create -- <short_description>");
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17); // yyyyMMddHHmmssSSS, UTC
    const file = path.join(MIGRATIONS_DIR, `${stamp}_${slug}.sql`);
    await writeFile(
        file,
        `-- ${slug.replace(/_/g, " ")}
--
-- Everything below runs in one transaction. Keep it backward compatible with
-- the backend version that is currently deployed (see migrations/README.md).

-- Up Migration


-- Down Migration

`,
        { flag: "wx" },
    );
    console.log(`Created ${path.relative(ROOT, file)}`);
}

async function baseline() {
    const files = await migrationFiles();
    if (!files[0] || !BASELINE_PATTERN.test(files[0])) {
        throw new Error(
            "The first migration file is not a baseline; nothing to mark.",
        );
    }
    await withClient(async (client) => {
        const applied = await appliedMigrations(client);
        if (applied.size > 0) {
            throw new Error(
                `This database already tracks ${applied.size} migration(s); baseline is only for the first adoption.`,
            );
        }
        const { rows } = await client.query(
            `SELECT to_regclass('public.users') AS t`,
        );
        if (!rows[0].t) {
            throw new Error(
                "This database has no SynchroStream tables. Run `npm run migrate:up` to build it from the baseline instead.",
            );
        }
    });
    await run({ direction: "up", count: 1, fake: true });
    console.log(`Marked ${files[0]} as applied without running it.`);
}

async function main() {
    const [command, ...args] = process.argv.slice(2);
    switch (command) {
        case "status":
            return status();
        case "create":
            return create(args.join("_"));
        case "up":
            return run({
                direction: "up",
                count: args[0] ? Number(args[0]) : Infinity,
            });
        case "down":
            if (!args.includes("--yes")) {
                throw new Error(
                    "Rolling back changes the schema the running backend uses. Re-run with --yes to confirm.",
                );
            }
            return run({ direction: "down", count: 1 });
        case "baseline":
            return baseline();
        default:
            throw new Error(
                "Usage: migrate.mjs <status|create <name>|up [count]|down --yes|baseline>",
            );
    }
}

main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
});
