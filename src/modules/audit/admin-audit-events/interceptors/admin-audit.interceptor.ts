import { HttpStatus, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA, REDIRECT_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { AdminAuditService } from '../services/admin-audit.service.js';

/**
 * Global: records every call to a handler decorated with `@AuditAction`, after it finished (success or error).
 * It does not change the response nor the error. Denials raised by the guards (401/403) never reach an
 * interceptor: `JwtAuthGuard`, `PasswordChangeGuard` and `RolesGuard` record those themselves through
 * `AdminAuditService`.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
    constructor(
        private readonly audit: AdminAuditService,
        private readonly reflector: Reflector,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (!this.audit.auditedAction(context)) return next.handle();
        return next.handle().pipe(
            mergeMap((value) => from(this.audit.recordOutcome(context, this.successStatus(context), value).then(() => value))),
            catchError((error: unknown) =>
                from(this.audit.recordError(context, error)).pipe(mergeMap(() => throwError(() => error)))),
        );
    }

    /**
     * The status the client gets. A handler that wrote the response itself (`@Res()`) already sent it, so that is
     * read as is. Otherwise Nest writes the response after the interceptors, so it is the handler's `@Redirect` or
     * `@HttpCode`, or Nest's default (201 for POST, 200 otherwise).
     */
    private successStatus(context: ExecutionContext): number {
        const http = context.switchToHttp();
        const response = http.getResponse<Response>();
        if (response.headersSent) return response.statusCode;
        const redirect = this.reflector.get<{ statusCode?: number } | undefined>(REDIRECT_METADATA, context.getHandler());
        if (redirect) return redirect.statusCode ?? HttpStatus.FOUND;
        const declared = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
        if (declared) return declared;
        return http.getRequest<Request>().method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
    }
}
