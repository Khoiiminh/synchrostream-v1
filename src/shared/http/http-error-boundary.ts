import type { HttpException } from "@nestjs/common";

/**
 * The boundary where a module's domain errors become the HTTP exceptions
 * clients see. Each module keeps its own error → status mapping (`toHttp`);
 * this only does the catching, so every module converts the same way:
 * domain errors are mapped, anything else is rethrown unchanged.
 */
export function httpErrorBoundary<E>(
    isDomainError: (error: unknown) => error is E,
    toHttp: (error: E) => HttpException,
) {
    const translate = (error: unknown): unknown =>
        isDomainError(error) ? toHttp(error) : error;

    /** Rethrows a domain error as its HTTP exception; anything else unchanged. */
    const rethrowAsHttp = (error: unknown): never => {
        throw translate(error);
    };

    /** Runs `fn`, converting domain errors it throws into HTTP exceptions. */
    const withHttpErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
            return await fn();
        } catch (error) {
            throw translate(error);
        }
    };

    return { rethrowAsHttp, withHttpErrors };
}
