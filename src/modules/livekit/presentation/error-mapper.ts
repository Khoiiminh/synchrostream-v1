import {
    ConflictException,
    ForbiddenException,
    HttpException,
    NotFoundException,
} from "@nestjs/common";
import { httpErrorBoundary } from "@/shared/http/http-error-boundary.js";
import { LiveKitDomainError } from "../domain/errors.js";

/** Domain error → the HTTP exception clients have always received. */
export function toHttpException(error: LiveKitDomainError): HttpException {
    switch (error.kind) {
        case "NOT_FOUND":
            return new NotFoundException(error.message);
        case "CONFLICT":
            return new ConflictException(error.message);
        case "FORBIDDEN":
            return new ForbiddenException(error.message);
        default: {
            const unhandled: never = error.kind;
            throw new Error(
                `Unmapped LiveKit domain error: ${String(unhandled)}`,
            );
        }
    }
}

export const { rethrowAsHttp, withHttpErrors } = httpErrorBoundary(
    (error: unknown): error is LiveKitDomainError =>
        error instanceof LiveKitDomainError,
    toHttpException,
);
