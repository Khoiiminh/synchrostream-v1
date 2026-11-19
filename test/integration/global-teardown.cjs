const {
    TEST_DATABASE_NAME,
    dropDatabase,
    withAdminClient,
} = require("./database.cjs");

module.exports = async function globalTeardown() {
    await withAdminClient((client) => dropDatabase(client, TEST_DATABASE_NAME));
};
