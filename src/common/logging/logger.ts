import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type { LoggerService } from "@nestjs/common";
import {
    pino,
    stdSerializers,
    type Logger as PinoLogger,
    type LoggerOptions,
} from "pino";

/**
 * Shared backend logger.
 *
 * Every `new Logger(Context.name)` from `@nestjs/common` is routed through
 * {@link AppLogger} (installed in main.ts with `app.useLogger`), so call sites
 * keep using the Nest API while output is pino JSON with one shape:
 *
 *   { level, time, service, context, requestId?, msg, ...fields, err? }
 *
 * Environment:
 *   LOG_LEVEL   trace | debug | info | warn | error | fatal | silent
 *               (default: "info" when NODE_ENV=production, otherwise "debug")
 *   LOG_FORMAT  json | pretty (default: "json" in production, otherwise "pretty"
 *               when pino-pretty is installed)
 */

export type LogFields = Record<string, unknown>;

const isProduction = process.env.NODE_ENV === "production";

/** Per-request context (requestId, ...) merged into every log line written inside it. */
const logContext = new AsyncLocalStorage<LogFields>();

export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
    const parent = logContext.getStore();
    return logContext.run(parent ? { ...parent, ...fields } : fields, fn);
}

function prettyTransportAvailable(): boolean {
    try {
        createRequire(import.meta.url).resolve("pino-pretty");
        return true;
    } catch {
        return false;
    }
}

function buildOptions(service: string): LoggerOptions {
    const format = process.env.LOG_FORMAT ?? (isProduction ? "json" : "pretty");
    const options: LoggerOptions = {
        level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
        base: { service },
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: { err: stdSerializers.err, error: stdSerializers.err },
        // Never write credentials, even if a caller passes a whole request/body object.
        redact: {
            paths: [
                "password",
                "*.password",
                "newPassword",
                "*.newPassword",
                "token",
                "*.token",
                "accessToken",
                "refreshToken",
                "authorization",
                "*.authorization",
                "headers.authorization",
                "headers.cookie",
            ],
            censor: "[redacted]",
        },
        mixin: () => logContext.getStore() ?? {},
    };
    if (format === "pretty" && prettyTransportAvailable()) {
        options.transport = {
            target: "pino-pretty",
            options: {
                translateTime: "SYS:HH:MM:ss.l",
                ignore: "pid,hostname,service",
                messageKey: "msg",
            },
        };
    }
    return options;
}

export const rootLogger: PinoLogger = pino(
    buildOptions("synchrostream-backend"),
);

/**
 * Nest framework contexts whose startup chatter ("Mapped {/v1/...} route",
 * "XModule dependencies initialized") is only useful while debugging.
 */
const FRAMEWORK_DEBUG_CONTEXTS = new Set([
    "InstanceLoader",
    "RoutesResolver",
    "RouterExplorer",
    "WebSocketsController",
]);

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const STACK_PATTERN = /^\s*at |\n\s+at /;

/**
 * Normalises Nest's `(message, ...optionalParams, context)` calling convention
 * into a single pino call:
 *  - message: a string, an Error, or `{ message, ...fields }`
 *  - optional params: Error -> `err`, stack string -> `err.stack`,
 *    plain object -> merged fields, anything else -> `details`
 *  - the trailing string param added by `new Logger(Context.name)` -> `context`
 */
export class AppLogger implements LoggerService {
    constructor(private readonly logger: PinoLogger = rootLogger) {}

    log(message: unknown, ...params: unknown[]) {
        this.write("info", message, params);
    }
    error(message: unknown, ...params: unknown[]) {
        this.write("error", message, params);
    }
    warn(message: unknown, ...params: unknown[]) {
        this.write("warn", message, params);
    }
    debug(message: unknown, ...params: unknown[]) {
        this.write("debug", message, params);
    }
    verbose(message: unknown, ...params: unknown[]) {
        this.write("trace", message, params);
    }
    fatal(message: unknown, ...params: unknown[]) {
        this.write("fatal", message, params);
    }

    private write(level: Level, message: unknown, params: unknown[]): void {
        const rest = [...params];
        let context: string | undefined;
        if (rest.length > 0 && typeof rest[rest.length - 1] === "string") {
            const last = rest[rest.length - 1] as string;
            // A trailing stack string belongs to error(); context names never contain whitespace.
            if (!(level === "error" && STACK_PATTERN.test(last))) {
                context = last;
                rest.pop();
            }
        }

        if (
            level === "info" &&
            context &&
            FRAMEWORK_DEBUG_CONTEXTS.has(context)
        )
            level = "debug";
        if (!this.logger.isLevelEnabled(level)) return;

        const fields: LogFields = {};
        if (context) fields.context = context;
        let msg: string | undefined;

        if (message instanceof Error) {
            fields.err = message;
            msg = message.message;
        } else if (message !== null && typeof message === "object") {
            const { message: text, ...other } = message as LogFields;
            Object.assign(fields, other);
            msg = typeof text === "string" ? text : undefined;
        } else if (
            typeof message === "string" ||
            typeof message === "number" ||
            typeof message === "boolean" ||
            typeof message === "bigint"
        ) {
            msg = String(message);
        }

        const details: unknown[] = [];
        for (const param of rest) {
            if (param === undefined) continue;
            if (param instanceof Error) {
                fields.err = param;
            } else if (typeof param === "string" && STACK_PATTERN.test(param)) {
                if (
                    !(fields.err instanceof Error) &&
                    !(fields.error instanceof Error)
                ) {
                    fields.err = { message: msg, stack: param };
                }
            } else if (
                param !== null &&
                typeof param === "object" &&
                !Array.isArray(param)
            ) {
                Object.assign(fields, param);
            } else {
                details.push(param);
            }
        }
        if (details.length > 0) fields.details = details;
        // Errors under any other key would serialize as "{}"; give them the err shape too.
        for (const [key, value] of Object.entries(fields)) {
            if (key !== "err" && value instanceof Error)
                fields[key] = stdSerializers.err(value);
        }

        this.logger[level](fields, msg);
    }
}

/** Best-effort masking for e-mail addresses written to logs: "jane.doe@x.com" -> "ja***@x.com". */
export function maskEmail(
    email: string | undefined | null,
): string | undefined {
    if (!email) return undefined;
    const at = email.indexOf("@");
    if (at <= 0) return "***";
    return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
