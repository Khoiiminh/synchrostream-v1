import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Determine if the error is a recognized NestJS HttpException, or a raw 500 runtime crash
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Extract the error message strings
    let message = "An unexpected backend error occurred";
    let errorData: any = null;

    if (exception instanceof HttpException) {
      const resBody = exception.getResponse();

      if (typeof resBody === "string") {
        message = resBody;
      } else if (typeof resBody === "object" && resBody !== null) {
        //NestJS validation pipe stores array errors inside 'message'
        const nestMessage = (resBody as any).message;
        message = Array.isArray(nestMessage)
          ? "Validation failed"
          : (nestMessage || exception.message);

        // If it's a validation error array, pass the details into the 'data' field
        if (Array.isArray(nestMessage)) {
          errorData = nestMessage;  // Contains the specific field validation arrays
        } else {
          errorData = (resBody as any).error || null;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      success: false,
      message: message,
      data: errorData,
      timestamp: new Date().toISOString(),
    });
  }
}
