import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PasswordChangeGuard } from './password-change.guard.js';
import { PasswordChangeRequiredException } from '../exceptions/index.js';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../decorators/allow-password-change.decorator.js';

function run(user: any, allowed: boolean) {
    const reflector = new Reflector();
    const handler = () => undefined;
    if (allowed) Reflect.defineMetadata(ALLOW_PASSWORD_CHANGE_KEY, true, handler);
    const context: any = { getHandler: () => handler, getClass: () => class {}, switchToHttp: () => ({ getRequest: () => ({ user }) }) };
    return new PasswordChangeGuard(reflector).canActivate(context);
}

describe('PasswordChangeGuard (RF-A25)', () => {
    it('lets a normal account through', () => {
        expect(run({ id: 1, mustChangePassword: false }, false)).toBe(true);
    });

    it('public routes (no user) are not affected', () => {
        expect(run(undefined, false)).toBe(true);
    });

    it('an account that must change its password gets 403 PASSWORD_CHANGE_REQUIRED on anything else', () => {
        expect(() => run({ id: 1, mustChangePassword: true }, false)).toThrow(PasswordChangeRequiredException);
    });

    it('…except the endpoints marked to allow it (change-password, logout)', () => {
        expect(run({ id: 1, mustChangePassword: true }, true)).toBe(true);
    });
});
