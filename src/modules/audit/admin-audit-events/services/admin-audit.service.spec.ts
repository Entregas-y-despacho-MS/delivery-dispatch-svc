import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_KEY } from '../decorators/audit-action.decorator.js';
import { AdminAuditService } from './admin-audit.service.js';

const handler = (): void => undefined;

function context(request: Record<string, unknown>, declared: unknown = { action: 'user.role_changed', bodyFields: ['roleId'] }) {
    if (declared) Reflect.defineMetadata(AUDIT_ACTION_KEY, declared, handler);
    else Reflect.deleteMetadata(AUDIT_ACTION_KEY, handler);
    return {
        getType: () => 'http',
        getHandler: () => handler,
        switchToHttp: () => ({ getRequest: () => request }),
    } as any;
}

const request = (over: Record<string, unknown> = {}) => ({
    user: { id: 4, role: 'ADMIN' }, params: { id: '12' }, body: { roleId: 3, password: 'Secret123!' },
    correlationId: 'req-123456', ip: '::ffff:10.0.0.7', ...over,
});

function build(insert = vi.fn(async () => undefined)) {
    const service = new AdminAuditService({ insert } as any, new Reflector());
    const logged: unknown[] = [];
    (service as any).logger = { error: (entry: unknown) => logged.push(entry) };
    return { service, insert, logged };
}

describe('AdminAuditService.recordOutcome', () => {
    it('writes actor, role, action, entity, result, correlation, IP and only the allowed body fields', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request()), 200);
        expect(insert).toHaveBeenCalledTimes(1);
        const row = (insert.mock.calls[0] as any[])[0];
        expect(row).toMatchObject({
            actorUserId: 4, actorRole: 'ADMIN', action: 'user.role_changed', entityType: 'user', entityId: '12',
            result: 'success', statusCode: 200, correlationId: 'req-123456', ipAddress: '10.0.0.7', metadata: { roleId: 3 },
        });
        expect(row.id).toEqual(expect.any(String));
        expect(row.occurredAt).toBeInstanceOf(Date);
        expect(JSON.stringify(row)).not.toContain('Secret123!');
    });

    it('records a denial without an actor (no valid token)', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request({ user: undefined })), 401);
        expect((insert.mock.calls[0] as any[])[0]).toMatchObject({ actorUserId: null, actorRole: null, result: 'denied', statusCode: 401 });
    });

    it('does nothing for a handler that is not a sensitive action', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request(), null), 200);
        expect(insert).not.toHaveBeenCalled();
    });

    it('never stores a secret even if a handler metadata lists it as a body field', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request({ body: { password: 'Secret123!', token: 'eyJ' } }), { action: 'user.updated', bodyFields: ['password', 'token'] }), 200);
        expect((insert.mock.calls[0] as any[])[0].metadata).toEqual({});
    });

    it('still records when the body is not an object', async () => {
        for (const body of ['text', 42, null, [1, 2]]) {
            const { service, insert } = build();
            await expect(service.recordOutcome(context(request({ body })), 200)).resolves.toBeUndefined();
            expect((insert.mock.calls[0] as any[])[0].metadata).toEqual({});
        }
    });

    it('never throws even when building the event fails, and logs it', async () => {
        const { service, insert, logged } = build();
        const broken = { getType: () => 'http', getHandler: () => { throw new Error('reflection broke'); } } as any;
        await expect(service.recordOutcome(broken, 200)).resolves.toBeUndefined();
        expect(insert).not.toHaveBeenCalled();
        expect(logged).toEqual([expect.objectContaining({ event: 'admin_audit_build_failed', status: 200 })]);
    });

    it('uses no entity id when the action declares none', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request(), { action: 'planning.run', entityIdParam: null }), 201);
        expect((insert.mock.calls[0] as any[])[0].entityId).toBeNull();
    });

    it('takes the entity id from the id of the response when the action declares it (creations)', async () => {
        const { service, insert } = build();
        const declared = { action: 'user.created', entityIdFrom: 'response' };
        await service.recordOutcome(context(request({ params: {} }), declared), 201, { id: 77, username: 'x' });
        expect((insert.mock.calls[0] as any[])[0].entityId).toBe('77');
    });

    it('has no entity id from the response when there is none or it is not an id', async () => {
        for (const body of [undefined, null, 'text', {}, { id: {} }, { id: null }]) {
            const { service, insert } = build();
            await service.recordOutcome(context(request(), { action: 'user.created', entityIdFrom: 'response' }), 400, body);
            expect((insert.mock.calls[0] as any[])[0].entityId).toBeNull();
        }
    });

    it('takes the entity id from the authenticated user when the action declares it (own account)', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request({ params: { id: '999' } }), { action: 'auth.password_changed', entityIdFrom: 'actor' }), 200);
        expect((insert.mock.calls[0] as any[])[0].entityId).toBe('4');
    });

    it('has no entity id from the actor when the request had no valid token', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request({ user: undefined }), { action: 'auth.password_changed', entityIdFrom: 'actor' }), 401);
        expect((insert.mock.calls[0] as any[])[0].entityId).toBeNull();
    });

    it('ignores the route param when the entity id comes from the response or the actor', async () => {
        const { service, insert } = build();
        await service.recordOutcome(context(request({ params: { id: '999' } }), { action: 'user.created', entityIdFrom: 'response' }), 201, { id: 5 });
        expect((insert.mock.calls[0] as any[])[0].entityId).toBe('5');
    });
});

describe('AdminAuditService.recordError', () => {
    it('maps the error status to denied or failed, and an unknown error to 500', async () => {
        const { service, insert } = build();
        await service.recordError(context(request()), new ForbiddenException());
        await service.recordError(context(request()), new NotFoundException());
        await service.recordError(context(request()), new Error('boom'));
        const rows = insert.mock.calls.map((call) => (call as any[])[0]);
        expect(rows.map((row) => [row.result, row.statusCode])).toEqual([['denied', 403], ['failed', 404], ['failed', 500]]);
    });
});

describe('AdminAuditService.record — failure policy', () => {
    it('does not throw when the write fails, and logs the whole event as an error instead of hiding it', async () => {
        const { service, logged } = build(vi.fn(async () => { throw new Error('connection terminated'); }));
        await expect(service.recordOutcome(context(request()), 200)).resolves.toBeUndefined();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({
            event: 'admin_audit_write_failed', error: 'Error',
            audit: { action: 'user.role_changed', actorId: 4, entityId: '12', result: 'success', correlationId: 'req-123456' },
        });
        expect(JSON.stringify(logged[0])).not.toContain('Secret123!');
    });
});
