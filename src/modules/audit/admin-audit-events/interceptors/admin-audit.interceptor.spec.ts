import { ConflictException } from '@nestjs/common';
import { HTTP_CODE_METADATA, REDIRECT_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AdminAuditInterceptor } from './admin-audit.interceptor.js';

function setup(audited = true, method = 'PATCH', httpCode?: number, response: object = { headersSent: false, statusCode: 200 }, redirect?: object) {
    const handler = (): void => undefined;
    if (httpCode) Reflect.defineMetadata(HTTP_CODE_METADATA, httpCode, handler);
    if (redirect) Reflect.defineMetadata(REDIRECT_METADATA, redirect, handler);
    const context = {
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => ({ method }), getResponse: () => response }),
    } as any;
    const audit = {
        auditedAction: vi.fn(() => (audited ? { action: 'user.role_changed' } : null)),
        recordOutcome: vi.fn(async () => undefined),
        recordError: vi.fn(async () => undefined),
    };
    return { interceptor: new AdminAuditInterceptor(audit as any, new Reflector()), audit, context };
}

describe('AdminAuditInterceptor', () => {
    it('records a success with the status Nest will answer and returns the handler value untouched', async () => {
        const { interceptor, audit, context } = setup();
        const value = await lastValueFrom(interceptor.intercept(context, { handle: () => of({ id: 12 }) }));
        expect(value).toEqual({ id: 12 });
        expect(audit.recordOutcome).toHaveBeenCalledWith(context, 200, { id: 12 });
    });

    it('uses 201 for a POST and the handler @HttpCode when it has one', async () => {
        const post = setup(true, 'POST');
        await lastValueFrom(post.interceptor.intercept(post.context, { handle: () => of(null) }));
        expect(post.audit.recordOutcome).toHaveBeenCalledWith(post.context, 201, null);

        const noContent = setup(true, 'DELETE', 204);
        await lastValueFrom(noContent.interceptor.intercept(noContent.context, { handle: () => of(undefined) }));
        expect(noContent.audit.recordOutcome).toHaveBeenCalledWith(noContent.context, 204, undefined);
    });

    it('uses the status already sent by a handler that writes the response itself (@Res)', async () => {
        const { interceptor, audit, context } = setup(true, 'POST', undefined, { headersSent: true, statusCode: 202 });
        await lastValueFrom(interceptor.intercept(context, { handle: () => of(undefined) }));
        expect(audit.recordOutcome).toHaveBeenCalledWith(context, 202, undefined);
    });

    it('uses the @Redirect status, 302 when it declares none', async () => {
        const moved = setup(true, 'GET', undefined, undefined, { url: '/x', statusCode: 301 });
        await lastValueFrom(moved.interceptor.intercept(moved.context, { handle: () => of(undefined) }));
        expect(moved.audit.recordOutcome).toHaveBeenCalledWith(moved.context, 301, undefined);

        const found = setup(true, 'GET', undefined, undefined, { url: '/x' });
        await lastValueFrom(found.interceptor.intercept(found.context, { handle: () => of(undefined) }));
        expect(found.audit.recordOutcome).toHaveBeenCalledWith(found.context, 302, undefined);
    });

    it('records the error and rethrows exactly the same error', async () => {
        const { interceptor, audit, context } = setup();
        const error = new ConflictException();
        await expect(lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => error) }))).rejects.toBe(error);
        expect(audit.recordError).toHaveBeenCalledWith(context, error);
        expect(audit.recordOutcome).not.toHaveBeenCalled();
    });

    it('lets a handler that is not a sensitive action through without recording', async () => {
        const { interceptor, audit, context } = setup(false);
        await lastValueFrom(interceptor.intercept(context, { handle: () => of('ok') }));
        expect(audit.recordOutcome).not.toHaveBeenCalled();
        expect(audit.recordError).not.toHaveBeenCalled();
    });
});
