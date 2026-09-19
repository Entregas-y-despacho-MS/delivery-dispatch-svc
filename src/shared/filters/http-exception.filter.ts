import {
    ExceptionFilter, Catch, ArgumentsHost,
    HttpException, HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Normalizes all HTTP exceptions to a consistent response shape:
// { statusCode, error, message, path, timestamp }
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    catch(exception: HttpException, host: ArgumentsHost) {
        const ctx      = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request  = ctx.getRequest<Request>();
        const status   = exception.getStatus();
        const body     = exception.getResponse();

        const message = typeof body === 'string' ? body : (body as any).message ?? exception.message;

        // Domain error codes (e.g. USER_NOT_FOUND) take priority over generic HTTP codes.
        // This lets clients distinguish between multiple 404s without parsing messages.
        const domainError = typeof body === 'object' ? (body as any).error : undefined;
        const errorCode   = domainError ?? this.statusToCode(status);

        if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
            // `cause` (e.g. PdfGenerationException, StorageUploadException, OsrmRequestException)
            // is intentionally never sent to the client — logged here so it isn't lost entirely.
            const cause = typeof body === 'object' ? (body as any).cause : undefined;
            const suffix = cause ? ` — cause: ${cause}` : '';
            this.logger.error(`[${request.method}] ${request.url} → ${status}${suffix}`, exception.stack);
        }

        response.status(status).json({
            statusCode: status,
            error:      errorCode,
            message,
            path:       request.url,
            timestamp:  new Date().toISOString(),
        });
    }

    private statusToCode(status: number): string {
        const map: Record<number, string> = {
            400: 'BAD_REQUEST',
            401: 'UNAUTHORIZED',
            403: 'FORBIDDEN',
            404: 'NOT_FOUND',
            409: 'CONFLICT',
            422: 'UNPROCESSABLE_ENTITY',
            429: 'TOO_MANY_REQUESTS',
            500: 'INTERNAL_SERVER_ERROR',
        };
        return map[status] ?? 'HTTP_ERROR';
    }
}
