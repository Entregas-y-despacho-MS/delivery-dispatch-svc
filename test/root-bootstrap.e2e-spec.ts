// ST-310.2 (ES-310, Escenario 4) — bootstrap seguro de la cuenta root.
//
// Corre la misma función que usa `npm run seed` (seedRootUser) contra la base real y comprueba lo que un
// mock no puede: que la cuenta nace obligada a cambiar la contraseña (PasswordChangeGuard), que el secreto
// funciona para entrar, y que un seed repetido NO resetea una contraseña ya rotada.
// Requiere la base con el schema cargado, incluido el rol `root` (viene de schema/auth/roles/data.sql).
// Levanta el AppModule real y pega por HTTP con supertest. Autolimpiante (usuario con tag único por corrida).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { User } from '../src/modules/auth/users/entities/user.entity.js';
import { Role } from '../src/modules/auth/roles/entities/role.entity.js';
import { seedRootUser, RootSeedPasswordError } from '../src/database/seeds/root-bootstrap.js';

const BOOT_SECRET    = 'Boot-Secret-1234!';
const OTHER_SECRET   = 'Other-Secret-5678!';
const ROTATED_SECRET = 'Rotated-Secret-9012!';

describe('Bootstrap seguro del root — seedRootUser (e2e, ES-310 Escenario 4)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let apiPrefix: string;
    const run = Date.now().toString(36).toUpperCase();
    const username = `e2e_root_${run}`;
    const logs: string[] = [];

    const api = (p: string) => `/${apiPrefix}${p}`;
    const http = () => request(app.getHttpServer());
    const login = (password: string) => http().post(api('/auth/login')).send({ username, password });
    const seed = (env: Record<string, string | undefined>) =>
        seedRootUser(ds.getRepository(User), ds.getRepository(Role), { SEED_ROOT_USERNAME: username, SEED_ROOT_EMAIL: `${username}@e2e.test`, ...env }, (m) => logs.push(m));
    const row = async () => (await ds.query(
        `SELECT user_id, password_hash, requires_pwd_change FROM users WHERE username = $1`, [username],
    ))[0] as { user_id: number; password_hash: string; requires_pwd_change: boolean } | undefined;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

        // Same bootstrap as main.ts — route prefix, validation and error shape depend on it.
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform:            true,
            whitelist:            true,
            forbidNonWhitelisted: true,
            transformOptions:     { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        ds = moduleRef.get(DataSource);
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM password_history WHERE user_id IN (SELECT user_id FROM users WHERE username = $1)`, [username]);
        await ds.query(`DELETE FROM users WHERE username = $1`, [username]);
        await app.close();
    });

    it('sin secreto no crea ninguna cuenta y el error no trae contraseña', async () => {
        await expect(seed({ NODE_ENV: 'production' })).rejects.toThrow(RootSeedPasswordError);
        expect(await row()).toBeUndefined();
    });

    it('con secreto crea el root: entra con ese secreto, queda obligado a cambiarlo y el valor no se registra', async () => {
        await seed({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: BOOT_SECRET });

        const created = await row();
        expect(created?.requires_pwd_change).toBe(true);
        expect(created?.password_hash).not.toContain(BOOT_SECRET);
        expect(logs.join('\n')).not.toContain(BOOT_SECRET);

        const res = await login(BOOT_SECRET);
        expect(res.status).toBe(200);
        expect(res.body.mustChangePassword).toBe(true);

        // Hasta rotar la contraseña, el resto de la API responde 403 PASSWORD_CHANGE_REQUIRED.
        const blocked = await http().get(api('/settings')).set({ Authorization: `Bearer ${res.body.accessToken}` });
        expect(blocked.status).toBe(403);
        expect(blocked.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('un seed repetido no resetea una contraseña ya rotada, aunque haya otro secreto configurado', async () => {
        const first = await login(BOOT_SECRET);
        const change = await http().patch(api('/auth/change-password'))
            .set({ Authorization: `Bearer ${first.body.accessToken}` })
            .send({ currentPassword: BOOT_SECRET, newPassword: ROTATED_SECRET });
        expect(change.status).toBeLessThan(300);

        const rotated = await row();
        expect(rotated?.requires_pwd_change).toBe(false);

        await seed({ NODE_ENV: 'production', SEED_ROOT_PASSWORD: OTHER_SECRET });
        await seed({ NODE_ENV: 'production' }); // producción sin la variable: el root existente no la pide

        const after = await row();
        expect(after?.password_hash).toBe(rotated?.password_hash);
        expect(after?.requires_pwd_change).toBe(false);
        expect((await login(ROTATED_SECRET)).status).toBe(200);
        expect((await login(OTHER_SECRET)).status).toBe(401);
        expect((await login(BOOT_SECRET)).status).toBe(401);
    });
});
