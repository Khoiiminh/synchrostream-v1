/*
 * Disposable Postgres for integration tests (`*.int-spec.ts`).
 *
 * The admin URL points at a throwaway local server, by default the Docker
 * container started with `npm run test:int:db`. Every run creates a fresh
 * database from the real migrations and drops it afterwards.
 *
 * Safety: refuses any host other than localhost. `.env.development` points at
 * the shared cloud database and is never read here.
 *
 * Plain CommonJS so Jest's globalSetup/globalTeardown can load it directly
 * (they run without moduleNameMapper). Types: database.d.cts.
 */
const { Client } = require("pg");

const DEFAULT_ADMIN_URL =
    "postgres://postgres:synchrostream-test@127.0.0.1:55432/postgres";
const TEST_DATABASE_NAME = "synchrostream_it";
/** Set by global setup; read by the specs. */
const TEST_DATABASE_URL_ENV = "SYNCHROSTREAM_IT_DATABASE_URL";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertLocal(connectionString) {
    const host = new URL(connectionString).hostname;
    if (!LOCAL_HOSTS.has(host)) {
        throw new Error(
            `Integration tests only run against a local, disposable Postgres (got host "${host}").`,
        );
    }
}

function adminUrl() {
    const url = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
    assertLocal(url);
    return url;
}

function databaseUrl(admin, database) {
    const url = new URL(admin);
    url.pathname = `/${database}`;
    return url.toString();
}

async function withAdminClient(fn) {
    const client = new Client({ connectionString: adminUrl() });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

async function dropDatabase(client, name) {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

module.exports = {
    DEFAULT_ADMIN_URL,
    TEST_DATABASE_NAME,
    TEST_DATABASE_URL_ENV,
    assertLocal,
    adminUrl,
    databaseUrl,
    withAdminClient,
    dropDatabase,
};
