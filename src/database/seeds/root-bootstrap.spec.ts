import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RootSeedPasswordError, describeSeedError, requireRootPassword, seedRootUser } from './root-bootstrap.js';
import { comparePassword } from '../../shared/utils/crypto.util.js';

// ST-310.2 — bootstrap of the root account. bcrypt stays real (see rules/back-testing.md).

const SECRET = 'Sup3r-Secret-Value!';

describe('requireRootPassword', () => {
    it('rechaza la ausencia del secreto en producción con un mensaje claro', () => {
        expect(() => requireRootPassword({ NODE_ENV: 'production' })).toThrow(RootSeedPasswordError);
        expect(() => requireRootPassword({ NODE_ENV: 'production' })).toThrow(/SEED_ROOT_PASSWORD is required.*in production/);
    });

    it('también lo exige fuera de producción: no hay contraseña por defecto en ningún entorno', () => {
        expect(() => requireRootPassword({ NODE_ENV: 'development' })).toThrow(/SEED_ROOT_PASSWORD is required/);
        expect(() => requireRootPassword({})).toThrow(RootSeedPasswordError);
    });

    it('trata una cadena vacía como ausente', () => {
        expect(() => requireRootPassword({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: '' })).toThrow(/required/);
    });

    it('rechaza un secreto que no cumple la política y no lo incluye en el mensaje', () => {
        const weak = 'weakvalue';
        let message = '';
        try { requireRootPassword({ SEED_ROOT_PASSWORD: weak }); } catch (e) { message = (e as Error).message; }
        expect(message).toMatch(/does not meet the password policy/);
        expect(message).not.toContain(weak);
    });

    it.each([
        ['solo espacios', '        '],
        ['espacio al final', 'Abcdef1! '],
        ['salto de línea al final (.env de Windows)', 'Abcdef1!\r\n'],
        ['espacio al inicio', ' Abcdef1!'],
    ])('rechaza espacios en los extremos sin recortarlos: %s', (_label, value) => {
        expect(() => requireRootPassword({ SEED_ROOT_PASSWORD: value })).toThrow(RootSeedPasswordError);
    });

    it.each([
        ['sin mayúscula', 'abcdef1!'],
        ['sin minúscula', 'ABCDEF1!'],
        ['sin número', 'Abcdefg!'],
        ['sin símbolo', 'Abcdefg1'],
        ['menos de 8 caracteres', 'Abc1!'],
    ])('exige cada requisito de la política: %s', (_label, value) => {
        expect(() => requireRootPassword({ SEED_ROOT_PASSWORD: value })).toThrow(/password policy/);
        expect(requireRootPassword({ SEED_ROOT_PASSWORD: 'Abcdef1!' })).toBe('Abcdef1!');
    });

    it('rechaza la antigua contraseña por defecto aunque cumpla la política (ya es pública)', () => {
        const retired = 'Root1234!';
        let message = '';
        try { requireRootPassword({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: retired }); } catch (e) { message = (e as Error).message; }
        expect(message).toMatch(/previously published default/);
        expect(message).not.toContain(retired);
    });

    it('nunca acepta la antigua contraseña fija como valor implícito', () => {
        expect(() => requireRootPassword({ NODE_ENV: 'production' })).toThrow();
    });

    it('devuelve el secreto cuando está presente y es válido', () => {
        expect(requireRootPassword({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: SECRET })).toBe(SECRET);
    });
});

describe('describeSeedError', () => {
    it('no vuelca parámetros ni query de un error de base de datos (el hash no llega al log)', () => {
        const hash = '$2b$10$abcdefghijklmnopqrstuv';
        const dbError = Object.assign(new Error('duplicate key value violates unique constraint "uq_users_username"'), {
            name: 'QueryFailedError',
            query: 'INSERT INTO users (password_hash) VALUES ($1)',
            parameters: [hash],
        });

        const text = describeSeedError(dbError);

        expect(text).toContain('duplicate key value');
        expect(text).not.toContain(hash);
        expect(text).not.toContain('INSERT INTO');
    });

    it('no revela el contenido de algo que no es un Error', () => {
        expect(describeSeedError({ password: SECRET })).toBe('Unknown error');
    });
});

describe('seedRootUser', () => {
    let userRepo: { findOne: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
    let roleRepo: { findOneBy: ReturnType<typeof vi.fn> };
    let logs: string[];
    const log = (m: string) => { logs.push(m); };

    beforeEach(() => {
        logs = [];
        userRepo = {
            findOne: vi.fn().mockResolvedValue(null),
            create:  vi.fn((x: object) => x),
            save:    vi.fn(async (x: object) => x),
        };
        roleRepo = { findOneBy: vi.fn().mockResolvedValue({ id: 1, name: 'root' }) };
    });

    const run = (env: Record<string, string | undefined>) => seedRootUser(userRepo as any, roleRepo as any, env, log);

    it('en producción sin secreto falla antes de escribir nada', async () => {
        await expect(run({ NODE_ENV: 'production' })).rejects.toThrow(/SEED_ROOT_PASSWORD is required/);
        expect(roleRepo.findOneBy).not.toHaveBeenCalled();
        expect(userRepo.create).not.toHaveBeenCalled();
        expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('con secreto crea el root con la contraseña hasheada y cambio inicial obligatorio', async () => {
        await run({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: SECRET });

        expect(userRepo.save).toHaveBeenCalledTimes(1);
        const saved = userRepo.create.mock.calls[0][0];
        expect(saved).toMatchObject({ username: 'root', roleId: 1, requiresPwdChange: true });
        expect(saved.passwordHash).not.toBe(SECRET);
        expect(await comparePassword(SECRET, saved.passwordHash)).toBe(true);
    });

    it('no registra el valor del secreto ni su hash en los logs', async () => {
        const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        try {
            await run({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: SECRET });
            const hash = userRepo.create.mock.calls[0][0].passwordHash as string;
            const everything = [...logs, ...consoleSpies.flatMap((s) => s.mock.calls.flat().map(String))].join('\n');
            expect(everything).not.toContain(SECRET);
            expect(everything).not.toContain(hash);
            expect(logs.length).toBeGreaterThan(0);
        } finally {
            consoleSpies.forEach((s) => s.mockRestore());
        }
    });

    it('un root existente se salta sin leer el secreto ni tocar nada (producción sin variable)', async () => {
        userRepo.findOne.mockResolvedValue({ id: 9, username: 'root' });

        await expect(run({ NODE_ENV: 'production' })).resolves.toBeUndefined();

        expect(roleRepo.findOneBy).not.toHaveBeenCalled();
        expect(userRepo.create).not.toHaveBeenCalled();
        expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('un root existente no se sobrescribe aunque haya un secreto distinto configurado', async () => {
        userRepo.findOne.mockResolvedValue({ id: 9, username: 'root' });

        await run({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: 'Other-Secret-1!' });

        expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('respeta el username personalizado al buscar el root existente', async () => {
        await run({ SEED_ROOT_USERNAME: 'owner', SEED_ROOT_PASSWORD: SECRET });

        expect(userRepo.findOne).toHaveBeenCalledWith({ where: { username: 'owner' } });
        expect(userRepo.create.mock.calls[0][0].username).toBe('owner');
    });

    it('falla con un error claro si el rol root no existe', async () => {
        roleRepo.findOneBy.mockResolvedValue(null);
        await expect(run({ SEED_ROOT_PASSWORD: SECRET })).rejects.toThrow(/Root role not found/);
        expect(userRepo.save).not.toHaveBeenCalled();
    });
});
