// Starts or stops the disposable Postgres used by `npm run test:int`.
//
//   npm run test:int:db        start (replaces an existing container)
//   npm run test:int:db:stop   remove it
//
// Postgres 18 because the baseline migration uses the built-in uuidv7().
// Data lives in tmpfs and the port is bound to 127.0.0.1 only.
import { spawnSync } from "node:child_process";

const NAME = "synchrostream-test-pg";
const docker = (args, opts = {}) =>
    spawnSync("docker", args, { encoding: "utf8", ...opts });

docker(["rm", "-f", NAME]);
if (process.argv[2] === "stop") {
    console.log(`Removed ${NAME}.`);
    process.exit(0);
}

const run = docker([
    "run", "-d", "--name", NAME,
    "-e", "POSTGRES_PASSWORD=synchrostream-test",
    "-p", "127.0.0.1:55432:5432",
    "--tmpfs", "/var/lib/postgresql:rw",
    "postgres:18-alpine",
]);
if (run.status !== 0) {
    console.error(run.stderr || "docker run failed (is Docker Desktop running?)");
    process.exit(1);
}

for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = docker(["exec", NAME, "pg_isready", "-U", "postgres", "-q"]);
    if (ready.status === 0) {
        console.log(`${NAME} is ready on 127.0.0.1:55432.`);
        process.exit(0);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
console.error(`${NAME} did not become ready.`);
process.exit(1);
