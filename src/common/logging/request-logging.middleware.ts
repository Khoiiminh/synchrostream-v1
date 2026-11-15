import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { runWithLogContext } from "./logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/;
const logger = new Logger("HTTP");

/**
 * Express middleware: assigns a request id (reusing a well-formed incoming
 * `x-request-id`), echoes it on the response, makes it part of every log line
 * written while handling the request, and writes one access-log line on finish.
 */
export function requestLoggingMiddleware(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const fields = {
            message: "HTTP request completed",
            requestId,
            method: req.method,
            path: req.originalUrl.split("?")[0],
            status: res.statusCode,
            durationMs: Math.round(durationMs * 10) / 10,
        };
        if (res.statusCode >= 500) logger.error(fields);
        else if (res.statusCode >= 400) logger.warn(fields);
        else logger.log(fields);
    });

    runWithLogContext({ requestId }, next);
}
