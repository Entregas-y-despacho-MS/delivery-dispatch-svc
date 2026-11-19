import { describe, expect, it } from 'vitest';
import { ADMIN_AUDIT_CATALOG } from './admin-audit-catalog.js';
import { buildAuditEvent, normalizeCorrelationId, normalizeIp, redactMetadata, resultForStatus } from './admin-audit-event.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('buildAuditEvent', () => {
    it('fills every required field of the contract', () => {
        const now = new Date('2026-11-19T15:00:00Z');
        const event = buildAuditEvent({
            action: 'user.role_changed', actor: { id: 4, role: 'ADMIN' }, entityId: '12', result: 'success',
            statusCode: 200, correlationId: 'req-123456', ip: '::ffff:10.0.0.7', metadata: { roleId: 3 }, now,
        });
        expect(event.eventId).toMatch(UUID);
        expect(event).toMatchObject({
            occurredAt: now, actorId: 4, actorRole: 'ADMIN', action: 'user.role_changed', entityType: 'user',
            entityId: '12', result: 'success', statusCode: 200, correlationId: 'req-123456', ip: '10.0.0.7', metadata: { roleId: 3 },
        });
    });

    it('takes the entity type from the catalog, never from the caller', () => {
        for (const action of Object.keys(ADMIN_AUDIT_CATALOG) as Array<keyof typeof ADMIN_AUDIT_CATALOG>) {
            const event = buildAuditEvent({ action, actor: null, entityId: null, result: 'denied', statusCode: 401, correlationId: null, ip: null });
            expect(event.entityType).toBe(ADMIN_AUDIT_CATALOG[action].entityType);
        }
    });

    it('records a request without actor, entity, correlation or IP', () => {
        const event = buildAuditEvent({ action: 'user.deleted', actor: null, entityId: undefined, result: 'denied', statusCode: 401, correlationId: undefined, ip: undefined });
        expect(event).toMatchObject({ actorId: null, actorRole: null, entityId: null, ip: null });
        expect(event.correlationId).toMatch(UUID);
    });

    it('gives every event its own id', () => {
        const input = { action: 'user.deleted' as const, actor: null, entityId: 1, result: 'success' as const, statusCode: 204, correlationId: 'same-request', ip: null };
        expect(buildAuditEvent(input).eventId).not.toBe(buildAuditEvent(input).eventId);
    });
});

describe('redactMetadata', () => {
    it('drops secrets whatever the handler declared', () => {
        expect(redactMetadata({
            password: 'Secret123!', newPassword: 'x', refreshToken: 'eyJ', accessToken: 'eyJ', totpCode: '123456', otp: '9',
            signature: 'base64', apiSecret: 's', authorization: 'Bearer x', cookie: 'c', passwordHash: 'h', roleId: 3,
        })).toEqual({ roleId: 3 });
    });

    it('drops personal data but keeps catalog codes', () => {
        expect(redactMetadata({
            email: 'a@b.com', phone: '+591', fullName: 'Ana', name: 'Ana', contactEmail: 'x', deliveryAddress: 'Calle',
            zoneCode: 'LPZ-SUR', reasonCode: 'INC-CUST-ABSENT', serviceLevelCode: 'STD', code: '123456', verificationCode: '1',
        })).toEqual({ zoneCode: 'LPZ-SUR', reasonCode: 'INC-CUST-ABSENT', serviceLevelCode: 'STD' });
    });

    it('keeps only scalars and trims long strings', () => {
        const clean = redactMetadata({ reason: 'x'.repeat(500), nested: { a: 1 }, list: [1], active: false, none: null, count: 2 });
        expect(clean).toEqual({ reason: 'x'.repeat(200), active: false, none: null, count: 2 });
    });
});

describe('normalizeCorrelationId', () => {
    it('accepts a well-formed client id and rejects anything else', () => {
        expect(normalizeCorrelationId('0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10')).toBe('0192f1e2-7c3a-7b41-9a1e-5d2f0c8e4a10');
        expect(normalizeCorrelationId('short')).toBeNull();
        expect(normalizeCorrelationId('has spaces in it')).toBeNull();
        expect(normalizeCorrelationId('x'.repeat(65))).toBeNull();
        expect(normalizeCorrelationId('line\nbreak-123')).toBeNull();
        expect(normalizeCorrelationId(['a-list-123'])).toBeNull();
    });
});

describe('normalizeIp', () => {
    it('stores IPv4-mapped addresses as IPv4 and keeps IPv6', () => {
        expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
        expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
        expect(normalizeIp('')).toBeNull();
    });
});

describe('resultForStatus', () => {
    it.each([[200, 'success'], [201, 'success'], [204, 'success'], [401, 'denied'], [403, 'denied'], [400, 'failed'], [404, 'failed'], [409, 'failed'], [500, 'failed']])(
        '%i is %s', (status, result) => {
            expect(resultForStatus(status)).toBe(result);
        },
    );
});
