// ST-13.3 — pruebas unitarias de autenticación y bloqueo temporal (RF-A21).
// ST-17.3 — pruebas unitarias de mustChangePassword / caducidad por antigüedad (RF-A25, Escenario 2).
// Todo mockeado (UsersService, JwtService, SettingsService, etc.) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { InvalidCredentialsException, AccountLockedException } from '../exceptions/index.js';
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

interface ServiceOptions {
    user?:               ReturnType<typeof buildAuthUser> | null;
    expirationDays?:     number;
    maxFailedAttempts?:  number;
    lockoutMinutes?:     number;
}

function buildService(options: ServiceOptions = {}) {
    const {
        user               = buildAuthUser(),
        expirationDays     = 90,
        maxFailedAttempts  = 5,
        lockoutMinutes     = 15,
    } = options;

    const settingsValues: Record<string, number> = {
        password_expiration_days:  expirationDays,
        max_failed_login_attempts: maxFailedAttempts,
        account_lockout_minutes:   lockoutMinutes,
    };

    const usersService = {
        findOneByUsername: vi.fn().mockResolvedValue(user),
        findOneById:        vi.fn().mockResolvedValue(user ? { id: user.id, username: user.username } : null),
        setLockoutState:    vi.fn(),
        setRefreshToken:    vi.fn(),
    };
    const jwtService = { sign: vi.fn().mockReturnValue('signed.jwt.token') };
    const jwtConfig   = { refreshSecret: 'secret', refreshExpiresIn: '7d' };
    const twoFactor   = { verify: vi.fn() };
    const mailer      = { send: vi.fn() };
    const settings    = {
        getNumber: vi.fn((key: string, fallback: number) => settingsValues[key] ?? fallback),
    };

    const service = new AuthService(usersService as any, jwtService as any, jwtConfig as any, twoFactor as any, mailer as any, settings as any);
    return { service, usersService, settings };
}

describe('AuthService — login / bloqueo temporal (RF-A21, ST-13.3)', () => {
    it('credenciales correctas → devuelve tokens y resetea el estado de bloqueo', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({ passwordHash: await hashPassword(password), failedAttempts: 2 });
        const { service, usersService } = buildService({ user });

        const result = await service.login({ username: user.username, password } as any);

        expect(result.accessToken).toBeDefined();
        expect(result.refreshToken).toBeDefined();
        expect(usersService.setLockoutState).toHaveBeenCalledWith(user.id, 0, null);
    });

    it('username inexistente → INVALID_CREDENTIALS (mensaje genérico, no revela si existe)', async () => {
        const { service } = buildService({ user: null });

        await expect(service.login({ username: 'nadie', password: 'lo que sea' } as any))
            .rejects.toThrow(InvalidCredentialsException);
    });

    it('password incorrecta → INVALID_CREDENTIALS y registra un intento fallido más', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), failedAttempts: 1 });
        const { service, usersService } = buildService({ user });

        await expect(service.login({ username: user.username, password: 'Incorrecta1!' } as any))
            .rejects.toThrow(InvalidCredentialsException);

        expect(usersService.setLockoutState).toHaveBeenCalledWith(user.id, 2, null);
    });

    it('llega al máximo de intentos configurado → bloquea la cuenta (lockedUntil futuro)', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), failedAttempts: 4 });
        const { service, usersService } = buildService({ user, maxFailedAttempts: 5, lockoutMinutes: 15 });

        await expect(service.login({ username: user.username, password: 'Incorrecta1!' } as any))
            .rejects.toThrow(InvalidCredentialsException);

        expect(usersService.setLockoutState).toHaveBeenCalledTimes(1);
        const [, failedAttempts, lockedUntil] = usersService.setLockoutState.mock.calls[0];
        expect(failedAttempts).toBe(5);
        expect(lockedUntil).toBeInstanceOf(Date);
        expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('cuenta ya bloqueada → ACCOUNT_LOCKED, sin siquiera comparar la contraseña', async () => {
        const user = buildAuthUser({
            passwordHash: await hashPassword('Passw0rd!'),
            lockedUntil:  new Date(Date.now() + 5 * 60_000),
        });
        const { service, usersService } = buildService({ user });

        // Ni siquiera manda la contraseña correcta — si igual rechaza, confirma que el chequeo de
        // bloqueo pasa antes que comparePassword.
        await expect(service.login({ username: user.username, password: 'Passw0rd!' } as any))
            .rejects.toThrow(AccountLockedException);

        expect(usersService.setLockoutState).not.toHaveBeenCalled();
    });

    it('respeta settings.max_failed_login_attempts configurado, no un valor fijo', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), failedAttempts: 1 });
        // Con el máximo bajado a 2, el 2do intento fallido ya debe bloquear.
        const { service, usersService } = buildService({ user, maxFailedAttempts: 2, lockoutMinutes: 15 });

        await expect(service.login({ username: user.username, password: 'Incorrecta1!' } as any))
            .rejects.toThrow(InvalidCredentialsException);

        const [, failedAttempts, lockedUntil] = usersService.setLockoutState.mock.calls[0];
        expect(failedAttempts).toBe(2);
        expect(lockedUntil).toBeInstanceOf(Date);
    });

    it('cuenta inactiva → INVALID_CREDENTIALS, mismo mensaje genérico que credenciales inválidas', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), active: false });
        const { service } = buildService({ user });

        await expect(service.login({ username: user.username, password: 'Passw0rd!' } as any))
            .rejects.toThrow(InvalidCredentialsException);
    });
});

describe('AuthService — mustChangePassword (RF-A25, Escenario 2)', () => {
    it('true si requiresPwdChange está en true, sin importar la antigüedad de la contraseña', async () => {
        const password = 'Passw0rd!';
        const user = buildAuthUser({
            passwordHash:      await hashPassword(password),
            requiresPwdChange: true,
            passwordChangedAt: new Date(), // recién cambiada — igual debe dar true por el flag
        });
        const { service } = buildService({ user });

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
        const { service } = buildService({ user, expirationDays: 90 });

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
        const { service } = buildService({ user, expirationDays: 90 });

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
        const { service, settings } = buildService({ user, expirationDays: 1 });

        const result = await service.login({ username: user.username, password } as any);
        expect(settings.getNumber).toHaveBeenCalledWith('password_expiration_days', 90);
        expect(result.mustChangePassword).toBe(true);
    });
});
