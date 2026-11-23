import { describe, expect, it } from 'vitest';
import { RoleEnum } from '../../../../shared/enums/index.js';
import type { AdminAuditEventEntity } from '../entities/admin-audit-event.entity.js';
import { InvalidAuditFilterException, InvalidAuditRangeException } from '../exceptions/invalid-audit-query.exception.js';
import { ADMIN_AUDIT_CATALOG } from './admin-audit-catalog.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, assertEntityFilter, resolveAuditRange, toAuditEventView } from './admin-audit-query.js';

describe('resolveAuditRange', () => {
    it('returns the window as dates, honouring the offset', () => {
        const range = resolveAuditRange('2026-11-20T00:00:00-04:00', '2026-11-21T00:00:00Z');
        expect(range.from.toISOString()).toBe('2026-11-20T04:00:00.000Z');
        expect(range.to.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    });

    it('accepts exactly 31 days and rejects one millisecond more', () => {
        expect(() => resolveAuditRange('2026-11-01T00:00:00Z', '2026-12-02T00:00:00Z')).not.toThrow();
        expect(() => resolveAuditRange('2026-11-01T00:00:00Z', '2026-12-02T00:00:00.001Z')).toThrow(InvalidAuditRangeException);
    });

    it.each([
        ['equal', '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z'],
        ['reversed', '2026-11-21T00:00:00Z', '2026-11-20T00:00:00Z'],
        ['unparseable', 'nope', '2026-11-20T00:00:00Z'],
    ])('rejects a %s window with INVALID_AUDIT_RANGE', (_name, from, to) => {
        try {
            resolveAuditRange(from, to);
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(InvalidAuditRangeException);
            expect((error as InvalidAuditRangeException).getResponse()).toMatchObject({ error: 'INVALID_AUDIT_RANGE' });
        }
    });
});

describe('assertEntityFilter', () => {
    it('rejects an entity id without its type', () => {
        expect(() => assertEntityFilter(undefined, '12')).toThrow(InvalidAuditFilterException);
    });

    it.each([[undefined, undefined], ['user', undefined], ['user', '12']])('accepts type %s with id %s', (type, id) => {
        expect(() => assertEntityFilter(type, id)).not.toThrow();
    });
});

describe('catalog-derived filter values', () => {
    it('lists every catalog action and each entity type once', () => {
        expect(AUDIT_ACTIONS).toEqual(Object.keys(ADMIN_AUDIT_CATALOG));
        expect(new Set(AUDIT_ENTITY_TYPES).size).toBe(AUDIT_ENTITY_TYPES.length);
        expect(AUDIT_ENTITY_TYPES).toContain('user');
    });
});

describe('toAuditEventView', () => {
    const event = {
        id: 'e1', actorUserId: 4, actorRole: 'admin', action: 'user.role_changed', entityType: 'user', entityId: '12',
        result: 'success', statusCode: 200, correlationId: 'req-123456', ipAddress: '10.0.0.7', metadata: { roleId: 3 },
        occurredAt: new Date('2026-11-20T10:00:00Z'), createdAt: new Date(),
    } as AdminAuditEventEntity;

    it('hides the address and the metadata from the administrator', () => {
        const view = toAuditEventView(event, RoleEnum.ADMIN);
        expect(view).toMatchObject({ eventId: 'e1', actorId: 4, action: 'user.role_changed', entityId: '12', result: 'success', correlationId: 'req-123456' });
        expect(view).not.toHaveProperty('ip');
        expect(view).not.toHaveProperty('metadata');
    });

    it('shows them to ROOT', () => {
        expect(toAuditEventView(event, RoleEnum.ROOT)).toMatchObject({ ip: '10.0.0.7', metadata: { roleId: 3 } });
    });

    it.each([RoleEnum.COORDINATOR, RoleEnum.SUPERVISOR, RoleEnum.DRIVER])('never shows them to %s', (role) => {
        const view = toAuditEventView(event, role);
        expect(view).not.toHaveProperty('ip');
        expect(view).not.toHaveProperty('metadata');
    });
});
