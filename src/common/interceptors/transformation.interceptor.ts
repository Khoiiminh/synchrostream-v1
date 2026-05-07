import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from 'rxjs/operators';

export interface Response<T> {
    success: boolean;
    message: string;
    data: T;
    timestamp: string;
}

@Injectable()
export class TransformationInterceptor<T> implements NestInterceptor<T, Response<T>> {
    intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Response<T>> | Promise<Observable<Response<T>>> {
        return next.handle().pipe(
            map((data: any) => ({
                success: true,
                message: data.message || 'Request processed successfully',
                data: data.data || (data.message ? (({ message, ...rest }) => rest)(data): data),
                timestamp: new Date().toISOString(),
            })),
        );
    }
}