import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/*
 * Architecture rules for the watch-party module (refactor plan phase 5, §6–§7),
 * enforced as a test because the lint plugin would need a new dependency.
 * domain/ and application/ purity have their own specs.
 *
 * Allowlisted exceptions are counted exactly: a new occurrence fails, and so
 * does removing one without updating the list.
 */

const SRC = resolve(__dirname, "../..");
const MODULE = __dirname;
const rel = (path: string) => relative(SRC, path).split(sep).join("/");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith(".ts") && !/[.-]spec\.ts$/.test(path) ? [path] : [];
    });
}

const ALL = sources(SRC);
const inModule = (f: string) => f.startsWith(MODULE + sep);
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function resolveImport(file: string, specifier: string): string | null {
    if (specifier.startsWith("@/")) return join(SRC, specifier.slice(2)).replace(/\.js$/, "");
    if (specifier.startsWith("src/")) return join(SRC, specifier.slice(4)).replace(/\.js$/, "");
    if (specifier.startsWith(".")) return resolve(dirname(file), specifier).replace(/\.js$/, "");
    return null; // package or node built-in
}

function imports(file: string): string[] {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(SPECIFIER)]
        .map(([, s]) => resolveImport(file, s))
        .filter((t): t is string => t !== null);
}

/** SQL statements that name a table: FROM/JOIN/INTO/UPDATE public.<table>. */
function tableUses(file: string, tables: string[]): number {
    const text = readFileSync(file, "utf8");
    const re = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+public\\.(?:${tables.join("|")})\\b`, "g");
    return (text.match(re) ?? []).length;
}

const WATCH_PARTY_TABLES = ["rooms", "room_participants", "room_lifecycle_outbox", "chat_history"];
const OTHER_TABLES = ["media_sessions", "sfu_nodes", "users", "movies"];

describe("watch-party architecture", () => {
    it("only watch-party writes SQL against its tables (one documented exception)", () => {
        const found = Object.fromEntries(
            ALL.filter((f) => !inModule(f))
                .map((f) => [rel(f), tableUses(f, WATCH_PARTY_TABLES)] as const)
                .filter(([, n]) => n > 0),
        );
        expect(found).toEqual({
            // insertCreatedSessionIfRoomActive: INSERT … SELECT FROM rooms FOR SHARE.
            // One statement, so the session is created only while the room is
            // ACTIVE; splitting it would change the locking.
            "modules/media-session-sfu/media-session.repository.ts": 1,
        });
    });

    it("watch-party touches other modules' tables only in one documented query", () => {
        const found = Object.fromEntries(
            ALL.filter(inModule)
                .map((f) => [rel(f), tableUses(f, OTHER_TABLES)] as const)
                .filter(([, n]) => n > 0),
        );
        expect(found).toEqual({
            // requeueStuckMediaSessions: the sweeper's read-only scan for stuck
            // LiveKit sessions, joined with rooms in one statement.
            "modules/watch-party/infrastructure/persistence/room-lifecycle-outbox.repository.ts": 1,
        });
    });

    it("other modules import watch-party only through queries/ (and AppModule its module)", () => {
        const violations = ALL.filter((f) => !inModule(f)).flatMap((file) =>
            imports(file)
                .filter((target) => target.startsWith(MODULE + sep))
                .filter((target) => !target.startsWith(join(MODULE, "queries") + sep))
                .filter((target) => !(rel(file) === "app.module.ts" && target === join(MODULE, "watch-party.module")))
                .map((target) => `${rel(file)} → ${rel(target)}`),
        );
        expect(violations).toEqual([]);
    });

    it("queries/ depends on no watch-party internals, so the contract cannot leak them", () => {
        const queries = ALL.filter((f) => f.startsWith(join(MODULE, "queries") + sep));
        expect(queries.length).toBeGreaterThan(0);
        const violations = queries.flatMap((file) =>
            imports(file)
                .filter((t) => t.startsWith(MODULE + sep) && !t.startsWith(join(MODULE, "queries") + sep))
                .map((t) => `${rel(file)} → ${rel(t)}`),
        );
        expect(violations).toEqual([]);
    });

    it("infrastructure/ never imports presentation/", () => {
        const infra = ALL.filter((f) => f.startsWith(join(MODULE, "infrastructure") + sep));
        expect(infra.length).toBeGreaterThan(0);
        const violations = infra.flatMap((file) =>
            imports(file)
                .filter((t) => t.startsWith(join(MODULE, "presentation") + sep))
                .map((t) => `${rel(file)} → ${rel(t)}`),
        );
        expect(violations).toEqual([]);
    });
});
