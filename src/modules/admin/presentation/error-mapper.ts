import {
    BadRequestException,
    HttpException,
    NotFoundException,
} from "@nestjs/common";
import { httpErrorBoundary } from "@/shared/http/http-error-boundary.js";
import { AdminDomainError } from "../domain/errors.js";

/** Domain error → the HTTP exception clients have always received. */
export function toHttpException(error: AdminDomainError): HttpException {
    switch (error.kind) {
        case "NOT_FOUND":
            return new NotFoundException(error.message);
        case "BAD_REQUEST":
            return new BadRequestException(error.message);
        default: {
            const unhandled: never = error.kind;
            throw new Error(
                `Unmapped admin domain error: ${String(unhandled)}`,
            );
        }
    }
}

export const { rethrowAsHttp, withHttpErrors } = httpErrorBoundary(
    (error: unknown): error is AdminDomainError =>
        error instanceof AdminDomainError,
    toHttpException,
);
