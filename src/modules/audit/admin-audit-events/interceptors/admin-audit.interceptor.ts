import { HttpStatus, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { AdminAuditService } from '../services/admin-audit.service.js';

/**
 * Global: records every call to a handler decorated with `@AuditAction`, after it finished (success or error).
 * It does not change the response nor the error. Denials raised by the guards (401/403) never reach an
 * interceptor: `JwtAuthGuard` and `RolesGuard` record those themselves through `AdminAuditService`.
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
            mergeMap((value) => from(this.audit.recordOutcome(context, this.successStatus(context)).then(() => value))),
            catchError((error: unknown) =>
                from(this.audit.recordError(context, error)).pipe(mergeMap(() => throwError(() => error)))),
        );
    }

    /**
     * The status Nest will answer with: the response is not written yet when the handler returns, so it is the
     * handler's `@HttpCode` or Nest's default (201 for POST, 200 otherwise).
     */
    private successStatus(context: ExecutionContext): number {
        const declared = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
        if (declared) return declared;
        return context.switchToHttp().getRequest<Request>().method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
    }
}
