import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

/** Envelope every successful HTTP response is wrapped in. */
export interface Response {
    success: boolean;
    message: string;
    /** The handler's `data` field, or its result minus `message`, or the raw result. */
    data: unknown;
    timestamp: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

@Injectable()
export class TransformationInterceptor<T> implements NestInterceptor<
    T,
    Response
> {
    intercept(
        context: ExecutionContext,
        next: CallHandler<T>,
    ): Observable<Response> | Promise<Observable<Response>> {
        return next.handle().pipe(
            map((data: T): Response => {
                const body = isRecord(data) ? data : undefined;
                let payload: unknown = data;
                if (body?.data) {
                    payload = body.data;
                } else if (body?.message) {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { message, ...rest } = body;
                    payload = rest;
                }
                return {
                    success: true,
                    message:
                        typeof body?.message === "string" && body.message
                            ? body.message
                            : "Request processed successfully",
                    data: payload,
                    timestamp: new Date().toISOString(),
                };
            }),
        );
    }
}
