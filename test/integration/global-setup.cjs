const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");
const {
    TEST_DATABASE_NAME,
    TEST_DATABASE_URL_ENV,
    adminUrl,
    assertLocal,
    databaseUrl,
    dropDatabase,
    withAdminClient,
} = require("./database.cjs");

/** Fresh database from the real migrations, once per test run. */
module.exports = async function globalSetup() {
    const url = databaseUrl(adminUrl(), TEST_DATABASE_NAME);
    assertLocal(url);

    try {
        await withAdminClient(async (client) => {
            await dropDatabase(client, TEST_DATABASE_NAME);
            await client.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);
        });
    } catch (error) {
        throw new Error(
            `Cannot reach the test Postgres. Start it with "npm run test:int:db". (${error.message})`,
        );
    }

    // The project's own migration runner, pointed only at the test database.
    // No --env-file: .env.development must not be loaded here.
    execFileSync(
        process.execPath,
        [resolve(__dirname, "../../scripts/migrate.mjs"), "up"],
        {
            cwd: resolve(__dirname, "../.."),
            env: { ...process.env, DATABASE_URL: url, DB_CA_CERT: "" },
            stdio: "pipe",
        },
    );

    process.env[TEST_DATABASE_URL_ENV] = url;
};
