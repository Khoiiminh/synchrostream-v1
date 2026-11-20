import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import type { Provider, Type } from "@nestjs/common";
import { WorkerModule } from "./worker.module.js";
import { TranscodeWorkerHost } from "./modules/admin/infrastructure/transcoding/transcode-worker.host.js";
import { TranscodeJobProcessor } from "./modules/admin/infrastructure/transcoding/transcode-job.processor.js";

/*
 * The worker must be able to resolve its providers on its own, and the API
 * process must never load ffmpeg: that is the point of the split.
 */

const SRC = __dirname;

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith(".ts") && !/[.-]spec\.ts$/.test(path)
            ? [path]
            : [];
    });
}

/** Files only the worker process loads. */
const WORKER_ONLY = new Set([
    "worker.ts",
    "worker.module.ts",
    "modules/admin/infrastructure/transcoding/transcode-pipeline.ts",
    "modules/admin/infrastructure/transcoding/transcode-job.processor.ts",
    "modules/admin/infrastructure/transcoding/transcode-telemetry.publisher.ts",
    "modules/admin/infrastructure/transcoding/transcode-worker.host.ts",
    "modules/admin/infrastructure/transcoding/worker.bindings.ts",
]);

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

/** Every project file `entry` loads, following relative and @/ imports. */
function importClosure(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
        const key = relative(SRC, file).split(sep).join("/");
        if (seen.has(key)) return;
        seen.add(key);
        for (const [, spec] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
            let target: string | null = null;
            if (spec.startsWith("@/")) target = join(SRC, spec.slice(2));
            else if (spec.startsWith("src/")) target = join(SRC, spec.slice(4));
            else if (spec.startsWith("."))
                target = resolve(dirname(file), spec);
            if (target) visit(target.replace(/\.js$/, "") + ".ts");
        }
    };
    visit(entry);
    return seen;
}

describe("transcode worker split", () => {
    it("resolves every WorkerModule provider without the HTTP app", async () => {
        const providers = Reflect.getMetadata(
            "providers",
            WorkerModule,
        ) as Provider[];

        // ConfigService is stubbed so no env file is loaded and, since
        // compile() runs no lifecycle hooks, nothing connects anywhere.
        const moduleRef = await Test.createTestingModule({
            providers: [
                ...providers,
                { provide: ConfigService, useValue: { get: () => undefined } },
            ],
        }).compile();

        expect(moduleRef.get(TranscodeWorkerHost)).toBeInstanceOf(
            TranscodeWorkerHost,
        );
        expect(moduleRef.get(TranscodeJobProcessor)).toBeInstanceOf(
            TranscodeJobProcessor,
        );
        const names = providers.map((p) => (p as Type).name);
        expect(names.some((n) => /Gateway|Controller/.test(n))).toBe(false);
    });

    it("keeps fluent-ffmpeg out of every file the API process loads", () => {
        const offenders = sources(SRC)
            .map((file) => relative(SRC, file).split(sep).join("/"))
            .filter((file) => !WORKER_ONLY.has(file))
            .filter((file) =>
                /["'](fluent-ffmpeg|@ffmpeg-installer\/ffmpeg)["']/.test(
                    readFileSync(join(SRC, file), "utf8"),
                ),
            );
        expect(offenders).toEqual([]);
    });

    it("AppModule never loads a worker-only file, even indirectly", () => {
        const loaded = importClosure(join(SRC, "app.module.ts"));
        expect(loaded.size).toBeGreaterThan(50);
        expect([...WORKER_ONLY].filter((f) => loaded.has(f))).toEqual([]);
    });

    it("keeps worker-only files out of AppModule's admin module", () => {
        const adminModule = readFileSync(
            join(SRC, "modules/admin/admin.module.ts"),
            "utf8",
        );
        for (const file of [...WORKER_ONLY].filter((f) =>
            f.startsWith("modules/"),
        )) {
            const base = file.split("/").pop()!.replace(/\.ts$/, "");
            expect(adminModule).not.toContain(base);
        }
    });
});
