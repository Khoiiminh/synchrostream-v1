import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/*
 * Architecture rules for the whole backend (plan "Backend clean architecture
 * and frontend vertical slices", phase B0), enforced as a test so no lint
 * plugin is needed.
 *
 *   1. Every table has one owning module. Other modules reach its data
 *      through the owner's queries/, not with their own SQL.
 *   2. A module imports another module only through its queries/ folder or
 *      a *.module.ts at its root. src/shared/ and src/common/ are open to all.
 *   3. src/shared/ and src/common/ import no module.
 *   4. Where a module has layers: domain/ imports only domain/ and node:;
 *      application/ imports only application/, domain/, <name>.types and node:;
 *      queries/ imports nothing else of its module; infrastructure/ never
 *      imports presentation/.
 *
 * Exceptions are counted exactly: a new occurrence fails, and so does
 * removing one without updating the list. Each says which phase removes it.
 */

const SRC = __dirname;
const MODULES = join(SRC, "modules");
const rel = (path: string) => relative(SRC, path).split(sep).join("/");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith(".ts") && !/[.-]spec\.ts$/.test(path)
            ? [path]
            : [];
    });
}

const ALL = sources(SRC);
const MODULE_NAMES = readdirSync(MODULES).filter((m) =>
    statSync(join(MODULES, m)).isDirectory(),
);

/** The module a path belongs to, or null for files outside src/modules. */
function moduleOf(path: string): string | null {
    const inside = relative(MODULES, path);
    if (inside.startsWith("..") || inside === "") return null;
    return inside.split(sep)[0];
}

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/** Raw specifiers, plus the resolved path (no .js) for project-local ones. */
function importsOf(
    file: string,
): { specifier: string; target: string | null }[] {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(SPECIFIER)].map(([, specifier]) => {
        let target: string | null = null;
        if (specifier.startsWith("@/")) target = join(SRC, specifier.slice(2));
        else if (specifier.startsWith("src/"))
            target = join(SRC, specifier.slice(4));
        else if (specifier.startsWith("."))
            target = resolve(dirname(file), specifier);
        return { specifier, target: target?.replace(/\.js$/, "") ?? null };
    });
}

const under = (path: string, dir: string) => path.startsWith(dir + sep);

// ---------------------------------------------------------------- tables --

const TABLE_OWNER: Record<string, string> = {
    users: "auth",
    movies: "media",
    media_sessions: "livekit",
    rooms: "watch-party",
    room_participants: "watch-party",
    room_lifecycle_outbox: "watch-party",
    chat_history: "watch-party",
};

/** SQL that names a table: FROM/JOIN/INTO/UPDATE [public.]<table>. */
function tableUses(file: string, table: string): number {
    const re = new RegExp(
        `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:public\\.)?${table}\\b`,
        "g",
    );
    return (readFileSync(file, "utf8").match(re) ?? []).length;
}

const FOREIGN_TABLE_USES: Record<string, number> = {
    // B4: password-reset folds into auth, which owns users.
    "modules/password-reset/password-reset.repository.ts → users": 5,
    // B3: admin writes the catalog through a MediaCatalogPort owned by media.
    "modules/admin/admin.repository.ts → movies": 6,
    // insertCreatedSessionIfRoomActive: INSERT … SELECT FROM rooms FOR SHARE,
    // one statement so the session is created only while the room is ACTIVE.
    // Splitting it would change the locking; stays a documented exception.
    "modules/livekit/media-session.repository.ts → rooms": 1,
    // requeueStuckMediaSessions: the outbox sweeper's read-only scan for stuck
    // LiveKit sessions, joined with rooms in one statement.
    "modules/watch-party/infrastructure/persistence/room-lifecycle-outbox.repository.ts → media_sessions": 1,
};

// --------------------------------------------------------------- imports --

/** The public entry points of a module: its queries/ folder and the *.module file(s) at its root. */
function isPublicEntry(target: string, module: string): boolean {
    const root = join(MODULES, module);
    return (
        under(target, join(root, "queries")) ||
        (dirname(target) === root && target.endsWith(".module"))
    );
}

const CROSS_MODULE_IMPORTS: Record<string, number> = {
    // WsJwtGuard reads the users table through AuthRepository, so it stays in
    // auth rather than shared/auth; the gateway uses it in @UseGuards.
    "modules/watch-party/watch-party.gateway.ts → modules/auth/guards/ws-jwt.guard": 1,
    // B2: the MEDIA_SESSION port binds to a livekit use-case facade exported
    // from livekit/queries/, instead of the concrete LiveKitService.
    "modules/watch-party/infrastructure/watch-party.bindings.ts → modules/livekit/livekit.service": 1,
    // B3: admin invalidates the catalog cache through a port owned by media.
    "modules/admin/admin.repository.ts → modules/media/media-catalog.cache": 1,
};

// ---------------------------------------------------------------- layers --

const LAYERED = MODULE_NAMES.filter(
    (m) =>
        statSync(join(MODULES, m)).isDirectory() &&
        readdirSync(join(MODULES, m)).includes("domain"),
);

function layerFiles(module: string, layer: string): string[] {
    const dir = join(MODULES, module, layer);
    try {
        return sources(dir);
    } catch {
        return [];
    }
}

function outsideImports(
    files: string[],
    allowed: (imp: { specifier: string; target: string | null }) => boolean,
): string[] {
    return files.flatMap((file) =>
        importsOf(file)
            .filter((imp) => !allowed(imp))
            .map(
                (imp) =>
                    `${rel(file)} → ${imp.target ? rel(imp.target) : imp.specifier}`,
            ),
    );
}

// ----------------------------------------------------------------- specs --

describe("backend architecture", () => {
    it("sees every module and every table", () => {
        expect(MODULE_NAMES.length).toBeGreaterThan(5);
        for (const owner of Object.values(TABLE_OWNER))
            expect(MODULE_NAMES).toContain(owner);
    });

    it("only a table's owner writes SQL against it (counted exceptions)", () => {
        const found: Record<string, number> = {};
        for (const file of ALL) {
            const module = moduleOf(file);
            for (const [table, owner] of Object.entries(TABLE_OWNER)) {
                if (module === owner) continue;
                const n = tableUses(file, table);
                if (n > 0) found[`${rel(file)} → ${table}`] = n;
            }
        }
        expect(found).toEqual(FOREIGN_TABLE_USES);
    });

    it("modules import each other only through queries/ or *.module (counted exceptions)", () => {
        const found: Record<string, number> = {};
        for (const file of ALL) {
            const from = moduleOf(file);
            for (const { target } of importsOf(file)) {
                if (!target) continue;
                const to = moduleOf(target);
                if (!to || to === from) continue;
                if (from === null && rel(file) === "app.module.ts") continue;
                if (from === null && rel(file) === "worker.module.ts") continue;
                if (isPublicEntry(target, to)) continue;
                const key = `${rel(file)} → ${rel(target)}`;
                found[key] = (found[key] ?? 0) + 1;
            }
        }
        expect(found).toEqual(CROSS_MODULE_IMPORTS);
    });

    it("shared/ and common/ import no module", () => {
        const kernel = ALL.filter(
            (f) =>
                under(f, join(SRC, "shared")) || under(f, join(SRC, "common")),
        );
        expect(kernel.length).toBeGreaterThan(0);
        expect(
            outsideImports(
                kernel,
                ({ target }) => !target || !under(target, MODULES),
            ),
        ).toEqual([]);
    });

    it("has at least one layered module to check", () => {
        expect(LAYERED).toContain("watch-party");
    });

    describe.each(LAYERED)("%s layers", (module) => {
        const root = join(MODULES, module);
        const inLayer = (target: string | null, ...layers: string[]) =>
            !!target && layers.some((l) => under(target, join(root, l)));

        it("domain/ imports only domain/ and node:", () => {
            expect(
                outsideImports(
                    layerFiles(module, "domain"),
                    ({ specifier, target }) =>
                        specifier.startsWith("node:") ||
                        inLayer(target, "domain"),
                ),
            ).toEqual([]);
        });

        it("application/ imports only application/, domain/, row types and node:", () => {
            expect(
                outsideImports(
                    layerFiles(module, "application"),
                    ({ specifier, target }) =>
                        specifier.startsWith("node:") ||
                        inLayer(target, "application", "domain") ||
                        target === join(root, `${module}.types`),
                ),
            ).toEqual([]);
        });

        it("queries/ depends on nothing else of its module", () => {
            expect(
                outsideImports(
                    layerFiles(module, "queries"),
                    ({ target }) =>
                        !target ||
                        !under(target, root) ||
                        inLayer(target, "queries"),
                ),
            ).toEqual([]);
        });

        it("infrastructure/ never imports presentation/", () => {
            expect(
                outsideImports(
                    layerFiles(module, "infrastructure"),
                    ({ target }) => !inLayer(target, "presentation"),
                ),
            ).toEqual([]);
        });
    });
});
