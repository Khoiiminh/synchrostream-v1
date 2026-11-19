import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/*
 * Keeps the application layer framework-free until the phase 5 lint rule
 * exists: a file under application/ may import only
 *   - other application/ files and domain/ files,
 *   - watch-party.types.ts (plain row types),
 *   - Node built-ins (node:*).
 * No @nestjs, pg, ioredis, socket.io, bcrypt, validators or shared infrastructure.
 */

const APPLICATION = __dirname;
const MODULE = resolve(APPLICATION, "..");
const ALLOWED_ROOTS = [APPLICATION, join(MODULE, "domain")];
const ALLOWED_FILES = [join(MODULE, "watch-party.types")];

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith(".ts") && !/[.-]spec\.ts$/.test(path)
            ? [path]
            : [];
    });
}

function allowed(file: string, specifier: string): boolean {
    if (specifier.startsWith("node:")) return true;
    if (!specifier.startsWith(".")) return false;
    const target = resolve(dirname(file), specifier).replace(/\.js$/, "");
    return (
        ALLOWED_FILES.includes(target) ||
        ALLOWED_ROOTS.some(
            (root) => target === root || target.startsWith(root + sep),
        )
    );
}

const files = sources(APPLICATION);

describe("application purity", () => {
    it("has source files to check", () => {
        expect(files.length).toBeGreaterThan(5);
    });

    it.each(files.map((f) => [relative(MODULE, f), f]))(
        "%s imports only application, domain, row types or node:",
        (_name, file) => {
            const text = readFileSync(file, "utf8");
            const outside = [...text.matchAll(SPECIFIER)]
                .map(([, specifier]) => specifier)
                .filter((specifier) => !allowed(file, specifier));
            expect(outside).toEqual([]);
        },
    );
});
