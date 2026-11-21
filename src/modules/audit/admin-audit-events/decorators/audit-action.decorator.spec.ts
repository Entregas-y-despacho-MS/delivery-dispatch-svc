import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_KEY, AuditAction } from './audit-action.decorator.js';

describe('AuditAction', () => {
    it('stores the action and its options on the handler', () => {
        class Controller { handler(): void {} }
        const descriptor = Object.getOwnPropertyDescriptor(Controller.prototype, 'handler')!;
        AuditAction('user.role_changed', { bodyFields: ['roleId'] })(Controller.prototype, 'handler', descriptor);
        expect(Reflect.getMetadata(AUDIT_ACTION_KEY, descriptor.value)).toEqual({ action: 'user.role_changed', bodyFields: ['roleId'] });
    });

    it.each([['password'], ['newPassword'], ['refreshToken'], ['totpCode'], ['email'], ['phone'], ['fullName']])(
        'refuses to declare %s as a body field when the app starts', (field) => {
            expect(() => AuditAction('user.updated', { bodyFields: [field] })).toThrow(/cannot include secrets or personal data/);
        },
    );

    it('refuses a fixed metadata key that is a secret or personal data, and accepts a plain one', () => {
        expect(() => AuditAction('auth.two_factor_changed', { metadata: { token: 'x' } })).toThrow(/cannot include secrets or personal data/);
        expect(() => AuditAction('auth.two_factor_changed', { metadata: { step: 'enable' } })).not.toThrow();
    });

    it('refuses an entity id source that ignores the route param it was given', () => {
        expect(() => AuditAction('user.created', { entityIdFrom: 'response', entityIdParam: 'id' })).toThrow(/entityIdParam only applies/);
        expect(() => AuditAction('auth.password_changed', { entityIdFrom: 'actor', entityIdParam: null })).toThrow(/entityIdParam only applies/);
        expect(() => AuditAction('user.created', { entityIdFrom: 'response' })).not.toThrow();
    });

    it('accepts business fields such as ids, flags and catalog codes', () => {
        expect(() => AuditAction('catalog.changed', { bodyFields: ['zoneCode', 'active', 'roleId', 'reasonCode'] })).not.toThrow();
    });
});
