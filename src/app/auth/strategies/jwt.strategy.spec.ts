// The access token is checked against the database on every request: a token is only as good as the user
// it names is NOW (it used to be trusted blindly for its whole 15 minutes).
import { describe, expect, it, vi } from 'vitest';
import { JwtStrategy } from './jwt.strategy.js';
import { RoleEnum } from '../../../shared/enums/index.js';

const NOW_S = Math.floor(Date.now() / 1000);

function build(snapshot: any, expirationDays = 90) {
    const usersService = { findForAuthentication: vi.fn().mockResolvedValue(snapshot) };
    const settings = { getNumber: vi.fn().mockReturnValue(expirationDays) };
    const strategy = new JwtStrategy({ secret: 's' } as any, usersService as any, settings as any);
    return { strategy, usersService };
}
const user = (over: object = {}) => ({ id: 7, username: 'ana', roleId: 3, role: RoleEnum.COORDINATOR, active: true, requiresPwdChange: false, passwordChangedAt: new Date(Date.now() - 86_400_000), ...over });
const payload = (over: object = {}) => ({ sub: 7, username: 'stale-name', roleId: 1, role: RoleEnum.ROOT, iat: NOW_S, exp: NOW_S + 900, ...over }) as any;

describe('JwtStrategy.validate', () => {
    it('returns the user as it is NOW, not what the token says (a stale root claim gives nothing)', async () => {
        const { strategy, usersService } = build(user());

        const result = await strategy.validate(payload());

        expect(usersService.findForAuthentication).toHaveBeenCalledWith(7);
        expect(result).toEqual({ id: 7, username: 'ana', roleId: 3, role: RoleEnum.COORDINATOR, mustChangePassword: false });
    });

    it('a deleted user (not found) → null (401)', async () => {
        expect(await build(null).strategy.validate(payload())).toBeNull();
    });

    it('a deactivated user → null (401) right away, not after the token expires', async () => {
        expect(await build(user({ active: false })).strategy.validate(payload())).toBeNull();
    });

    it('a token issued before the last password change → null (the change closes old tokens)', async () => {
        const changedAt = new Date((NOW_S - 10) * 1000);
        const { strategy } = build(user({ passwordChangedAt: changedAt }));

        expect(await strategy.validate(payload({ iat: NOW_S - 60 }))).toBeNull();
    });

    it('a token issued after the password change, or in the same second, is fine', async () => {
        const changedAt = new Date(NOW_S * 1000 + 400); // same second as the token
        const { strategy } = build(user({ passwordChangedAt: changedAt }));

        expect(await strategy.validate(payload({ iat: NOW_S }))).not.toBeNull();
        expect(await strategy.validate(payload({ iat: NOW_S + 5 }))).not.toBeNull();
    });

    it('flags mustChangePassword when an admin required it', async () => {
        expect((await build(user({ requiresPwdChange: true })).strategy.validate(payload()))!.mustChangePassword).toBe(true);
    });

    it('flags mustChangePassword when the password is older than password_expiration_days', async () => {
        const old = new Date(Date.now() - 91 * 86_400_000);
        expect((await build(user({ passwordChangedAt: old }), 90).strategy.validate(payload({ iat: NOW_S })))!.mustChangePassword).toBe(true);
        expect((await build(user({ passwordChangedAt: old }), 120).strategy.validate(payload({ iat: NOW_S })))!.mustChangePassword).toBe(false);
    });
});
