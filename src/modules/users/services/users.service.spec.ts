// ST-17.3 — pruebas unitarias de validación de contraseñas (RF-A25, Escenarios 1 y 3).
// Todo mockeado (repos de TypeORM, SettingsService) — sin DB, sin red.
import { describe, expect, it, vi } from 'vitest';
import { UsersService } from './users.service.js';
import { PasswordTooShortException, PasswordRecentlyUsedException } from '../exceptions/index.js';
import { hashPassword } from '../../../shared/utils/crypto.util.js';

function buildService(overrides: { minLength?: number } = {}) {
    const rawRepo = {
        findOneByOrFail: vi.fn(),
        update:          vi.fn(),
        findOne:         vi.fn(),
    };
    const historyRepo = {
        find:   vi.fn().mockResolvedValue([]),
        create: vi.fn((data: any) => data),
        save:   vi.fn(),
    };
    const settings = {
        getNumber: vi.fn().mockReturnValue(overrides.minLength ?? 8),
    };

    const service = new UsersService(rawRepo as any, historyRepo as any, settings as any);
    return { service, rawRepo, historyRepo, settings };
}

describe('UsersService — password policy (RF-A25)', () => {
    describe('Escenario 1 — mínimo dinámico (settings.password_min_length)', () => {
        it('rechaza una contraseña más corta que el mínimo configurado', async () => {
            const { service, rawRepo } = buildService({ minLength: 10 });
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });

            await expect(service.updatePassword(1, 'Short1!')).rejects.toThrow(PasswordTooShortException);
        });

        it('acepta una contraseña que cumple el mínimo configurado', async () => {
            const { service, rawRepo, historyRepo } = buildService({ minLength: 8 });
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });

            await service.updatePassword(1, 'LongEnough1!');

            expect(rawRepo.update).toHaveBeenCalled();
            expect(historyRepo.save).toHaveBeenCalled();
        });
    });

    describe('Escenario 3 — no reutilización (updatePassword)', () => {
        it('rechaza si la nueva contraseña es igual a la actual', async () => {
            const { service, rawRepo } = buildService();
            const currentHash = await hashPassword('CurrentPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: currentHash });

            await expect(service.updatePassword(1, 'CurrentPassw0rd!')).rejects.toThrow(PasswordRecentlyUsedException);
        });

        it('rechaza si la nueva contraseña coincide con alguna de las últimas 3 del historial', async () => {
            const { service, rawRepo, historyRepo } = buildService();
            const oldHash = await hashPassword('OldPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: await hashPassword('CurrentPassw0rd!') });
            historyRepo.find.mockResolvedValue([{ passwordHash: oldHash, createdAt: new Date() }]);

            await expect(service.updatePassword(1, 'OldPassw0rd!')).rejects.toThrow(PasswordRecentlyUsedException);
        });

        it('acepta una contraseña genuinamente nueva, la registra en el historial y limpia el estado', async () => {
            const { service, rawRepo, historyRepo } = buildService();
            const currentHash = await hashPassword('CurrentPassw0rd!');
            rawRepo.findOneByOrFail.mockResolvedValue({ id: 1, passwordHash: currentHash });
            historyRepo.find.mockResolvedValue([]);

            await service.updatePassword(1, 'BrandNewPassw0rd!');

            // Guarda el hash VIEJO en el historial (no el nuevo) — es "la contraseña que se reemplazó".
            expect(historyRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, passwordHash: currentHash }));

            const updatePayload = rawRepo.update.mock.calls[0][1];
            expect(updatePayload.requiresPwdChange).toBe(false);
            expect(updatePayload.failedAttempts).toBe(0);
            expect(updatePayload.lockedUntil).toBeNull();
            expect(updatePayload.passwordChangedAt).toBeInstanceOf(Date);
            expect(updatePayload.passwordHash).not.toBe(currentHash); // quedó hasheada, no en texto plano
        });
    });
});
