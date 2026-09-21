// ST-17.3 — pruebas unitarias de mustChangePassword / caducidad por antigüedad (RF-A25, Escenario 2).
// Todo mockeado (UsersService, JwtService, SettingsService, etc.) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { RoleEnum } from '../../../shared/enums/index.js';
import { hashPassword } from '../../../shared/utils/crypto.util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function buildAuthUser(overrides: Partial<Record<string, any>> = {}) {
    return {
        id:                1,
        username:          'atorrez',
        roleId:             3,
        active:             true,
        role:               { id: 3, name: RoleEnum.COORDINATOR },
        passwordHash:       overrides.passwordHash,
        refreshTokenHash:   null,
        failedAttempts:     0,
        lockedUntil:        null,
        twoFactorSecret:    null,
        twoFactorEnabled:   false,
        passwordResetExpiresAt: null,
        requiresPwdChange:  false,
        passwordChangedAt:  new Date(),
        ...overrides,
    };
}

async function buildService(user: ReturnType<typeof buildAuthUser>, expirationDays = 90) {
    const usersService = {
        findOneByUsername: vi.fn().mockResolvedValue(user),
        findOneById:        vi.fn().mockResolvedValue({ id: user.id, username: user.username }),
        setLockoutState:    vi.fn(),
        setRefreshToken:    vi.fn(),
    };
    const jwtService = { sign: vi.fn().mockReturnValue('signed.jwt.token') };
    const jwtConfig   = { refreshSecret: 'secret', refreshExpiresIn: '7d' };
    const twoFactor   = { verify: vi.fn() };
    const mailer      = { send: vi.fn() };
    const settings    = { getNumber: vi.fn().mockReturnValue(expirationDays) };

    const service = new AuthService(usersService as any, jwtService as any, jwtConfig as any, twoFactor as any, mailer as any, settings as any);
    return { service, usersService, settings };
}

describe('AuthService — mustChangePassword (RF-A25, Escenario 2)', () => {
    it('true si requiresPwdChange está en true, sin importar la antigüedad de la contraseña', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({
            passwordHash:      await hashPassword(password),
            requiresPwdChange: true,
            passwordChangedAt: new Date(), // recién cambiada — igual debe dar true por el flag
        });
        const { service } = await buildService(user);

        const result = await service.login({ username: user.username, password } as any);
        expect(result.mustChangePassword).toBe(true);
    });

    it('false si requiresPwdChange está en false y la contraseña está dentro del período de vigencia', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({
            passwordHash:      await hashPassword(password),
            requiresPwdChange: false,
            passwordChangedAt: new Date(Date.now() - 10 * DAY_MS), // 10 días, vigencia 90
        });
        const { service } = await buildService(user, 90);

        const result = await service.login({ username: user.username, password } as any);
        expect(result.mustChangePassword).toBe(false);
    });

    it('true si requiresPwdChange está en false pero la contraseña superó settings.password_expiration_days', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({
            passwordHash:      await hashPassword(password),
            requiresPwdChange: false,
            passwordChangedAt: new Date(Date.now() - 91 * DAY_MS), // 91 días, vigencia 90
        });
        const { service } = await buildService(user, 90);

        const result = await service.login({ username: user.username, password } as any);
        expect(result.mustChangePassword).toBe(true);
    });

    it('respeta el settings.password_expiration_days configurado, no un valor fijo', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({
            passwordHash:      await hashPassword(password),
            requiresPwdChange: false,
            passwordChangedAt: new Date(Date.now() - 5 * DAY_MS),
        });
        // Con vigencia bajada a 1 día, una contraseña de 5 días ya está vencida.
        const { service, settings } = await buildService(user, 1);

        const result = await service.login({ username: user.username, password } as any);
        expect(settings.getNumber).toHaveBeenCalledWith('password_expiration_days', 90);
        expect(result.mustChangePassword).toBe(true);
    });
});
