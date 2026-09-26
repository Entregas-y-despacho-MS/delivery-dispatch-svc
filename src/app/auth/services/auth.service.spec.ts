// ST-13.3 — pruebas unitarias de autenticación y bloqueo temporal (RF-A21).
// ST-17.3 — pruebas unitarias de mustChangePassword / caducidad por antigüedad (RF-A25, Escenario 2).
// Todo mockeado (UsersService, JwtService, SettingsService, etc.) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { InvalidCredentialsException, AccountLockedException, InvalidRefreshTokenException } from '../exceptions/index.js';
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
        registerFailedLogin: vi.fn(),
        setLastLogin:       vi.fn(),
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
        expect(usersService.setLastLogin).toHaveBeenCalledWith(user.id); // RF-A28: último acceso
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

        // El contador lo incrementa la base en un solo UPDATE atómico (ver e2e): acá solo se pide.
        expect(usersService.registerFailedLogin).toHaveBeenCalledWith(user.id, 5, 15 * 60_000);
        expect(usersService.setLastLogin).not.toHaveBeenCalled(); // un intento fallido no es un acceso
    });

    // Cuándo se llega al máximo y se bloquea la cuenta lo decide el UPDATE atómico de la base:
    // se prueba contra Postgres real en test/security-hardening.e2e-spec.ts.
    it('un login fallido registra el intento una sola vez, sin leer-y-escribir el contador desde acá', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), failedAttempts: 4 });
        const { service, usersService } = buildService({ user, maxFailedAttempts: 5, lockoutMinutes: 15 });

        await expect(service.login({ username: user.username, password: 'Incorrecta1!' } as any))
            .rejects.toThrow(InvalidCredentialsException);

        expect(usersService.registerFailedLogin).toHaveBeenCalledTimes(1);
        expect(usersService.setLockoutState).not.toHaveBeenCalled();
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
        expect(usersService.setLastLogin).not.toHaveBeenCalled();
    });

    it('respeta settings.max_failed_login_attempts configurado, no un valor fijo', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), failedAttempts: 1 });
        // Con el máximo bajado a 2 y el bloqueo a 30 min, eso es lo que se le pasa a la base.
        const { service, usersService } = buildService({ user, maxFailedAttempts: 2, lockoutMinutes: 30 });

        await expect(service.login({ username: user.username, password: 'Incorrecta1!' } as any))
            .rejects.toThrow(InvalidCredentialsException);

        expect(usersService.registerFailedLogin).toHaveBeenCalledWith(user.id, 2, 30 * 60_000);
    });

    it('cuenta inactiva → INVALID_CREDENTIALS, mismo mensaje genérico que credenciales inválidas', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!'), active: false });
        const { service, usersService } = buildService({ user });

        await expect(service.login({ username: user.username, password: 'Passw0rd!' } as any))
            .rejects.toThrow(InvalidCredentialsException);
        expect(usersService.setLastLogin).not.toHaveBeenCalled();
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

// ── rotación de refresh tokens ─────────────────────────────────────────────────
// Antes se guardaba un bcrypt del token, que solo lee sus primeros 72 bytes: TODOS los refresh tokens de
// un mismo usuario "coincidían" y un token ya rotado seguía sirviendo. Ahora se guarda su SHA-256.
describe('AuthService — refresh token: se guarda la huella completa, no un bcrypt', () => {
    async function withRealJwt(user: ReturnType<typeof buildAuthUser>) {
        const { JwtService } = await import('@nestjs/jwt');
        const jwt = new JwtService({ secret: 'access-secret' });
        const usersService = {
            findOneByUsername: vi.fn().mockResolvedValue(user),
            findOneById:       vi.fn(async () => ({ ...user })), // a fresh copy per call: tests change user.refreshTokenHash
            setLockoutState:   vi.fn(),
            setLastLogin:      vi.fn(),
            setRefreshToken:   vi.fn(),
        };
        const jwtConfig = { refreshSecret: 'refresh-secret', refreshExpiresIn: '7d' };
        const settings  = { getNumber: vi.fn((_k: string, fallback: number) => fallback) };
        const service   = new AuthService(usersService as any, jwt, jwtConfig as any, { verify: vi.fn() } as any, { send: vi.fn() } as any, settings as any);
        return { service, usersService };
    }

    it('login guarda el SHA-256 del refresh token (64 hex), no un hash bcrypt', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!') });
        const { service, usersService } = await withRealJwt(user);

        const { refreshToken } = await service.login({ username: user.username, password: 'Passw0rd!' } as any);

        const stored = usersService.setRefreshToken.mock.calls.at(-1)![1] as string;
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        expect(stored).toBe((await import('../../../shared/utils/crypto.util.js')).hashToken(refreshToken));
    });

    it('dos logins seguidos del mismo usuario dan refresh tokens distintos (jti único)', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!') });
        const { service } = await withRealJwt(user);

        const a = await service.login({ username: user.username, password: 'Passw0rd!' } as any);
        const b = await service.login({ username: user.username, password: 'Passw0rd!' } as any);

        expect(a.refreshToken).not.toBe(b.refreshToken);
    });

    it('refresh con el token vigente → tokens nuevos y se guarda la huella del nuevo', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!') });
        const { service, usersService } = await withRealJwt(user);
        const { refreshToken } = await service.login({ username: user.username, password: 'Passw0rd!' } as any);
        user.refreshTokenHash = usersService.setRefreshToken.mock.calls.at(-1)![1] as any;

        const next = await service.refresh({ refreshToken } as any);

        expect(next.refreshToken).not.toBe(refreshToken);
        expect(usersService.setRefreshToken.mock.calls.at(-1)![1]).not.toBe(user.refreshTokenHash);
    });

    it('un token YA ROTADO (mismo usuario, mismo inicio) es rechazado y cierra todas las sesiones', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!') });
        const { service, usersService } = await withRealJwt(user);
        const first = await service.login({ username: user.username, password: 'Passw0rd!' } as any);
        user.refreshTokenHash = usersService.setRefreshToken.mock.calls.at(-1)![1] as any;
        const second = await service.refresh({ refreshToken: first.refreshToken } as any); // rota: first ya no vale
        user.refreshTokenHash = usersService.setRefreshToken.mock.calls.at(-1)![1] as any;

        await expect(service.refresh({ refreshToken: first.refreshToken } as any)).rejects.toThrow(InvalidRefreshTokenException);

        expect(usersService.setRefreshToken).toHaveBeenLastCalledWith(user.id, null); // reuso → revoca todo
        expect(second.refreshToken).toBeDefined();
    });

    it('un hash bcrypt viejo en la base (de antes de este cambio) no sirve: hay que volver a iniciar sesión', async () => {
        const user = buildAuthUser({ passwordHash: await hashPassword('Passw0rd!') });
        const { service, usersService } = await withRealJwt(user);
        const { refreshToken } = await service.login({ username: user.username, password: 'Passw0rd!' } as any);
        user.refreshTokenHash = (await hashPassword(refreshToken)) as any;

        await expect(service.refresh({ refreshToken } as any)).rejects.toThrow(InvalidRefreshTokenException);
        expect(usersService.setRefreshToken).toHaveBeenLastCalledWith(user.id, null);
    });
});

describe('AuthService.register — solo root puede dar el rol root', () => {
    it('comprueba al que llama antes de crear la cuenta', async () => {
        const { service, usersService } = buildService();
        (usersService as any).assertCanManageRoot = vi.fn().mockRejectedValue(new Error('blocked'));
        (usersService as any).create = vi.fn();
        const actor = { id: 2, username: 'admin', roleId: 2, role: RoleEnum.ADMIN };

        await expect(service.register({ roleId: 1 } as any, actor)).rejects.toThrow('blocked');

        expect((usersService as any).assertCanManageRoot).toHaveBeenCalledWith(actor, { roleId: 1 });
        expect((usersService as any).create).not.toHaveBeenCalled();
    });
});
