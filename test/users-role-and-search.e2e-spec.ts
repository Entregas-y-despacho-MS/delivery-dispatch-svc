// Regression tests for two fixes, against a real database:
//  - a roleId that does not exist used to end in a 500 (FK violation); now it is a 400 INVALID_ROLE
//    on POST /users, POST /auth/register and PUT /users/:id;
//  - the text search of roles, delivery zones and vehicles used to treat % and _ as wildcards.
// Self-cleaning (unique run tag), safe to re-run against a shared database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('roleId inexistente y comodines de búsqueda (e2e)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let prefix: string;
    const tokens: Record<string, string> = {};
    let roleIds: Record<string, number> = {};

    const run = Date.now().toString(36).toUpperCase();
    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const api = (path: string) => `/${prefix}${path}`;
    const userBody = (username: string, roleId: unknown) => ({ fullName: 'E2E Role Test', username, password: 'Passw0rd!', roleId });
    const userCount = async (username: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM users WHERE username = $1`, [username]))[0].c as number;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        dataSource = moduleRef.get(DataSource);
        const passwordHash = await hashPassword('E2eTest1234');
        for (const r of await dataSource.query(`SELECT role_id, name FROM roles`)) roleIds[r.name] = r.role_id;
        for (const role of ['admin', 'coordinator', 'supervisor']) {
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [roleIds[role], `E2E ${role}`, `e2e_rs_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer()).post(api('/auth/login')).send({ username: `e2e_rs_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`%_rs_%_${run}`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_new_%_${run}`]);
        await dataSource.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`RS${run}%`]);
        await dataSource.query(`DELETE FROM vehicles WHERE plate LIKE $1`, [`RS${run}%`]);
        await app.close();
    });

    describe('roleId inexistente → 400 INVALID_ROLE (no 500)', () => {
        for (const [label, path] of [['POST /users', '/users'], ['POST /auth/register', '/auth/register']] as const) {
            it(`${label} con un roleId que no existe → 400 y no se crea el usuario`, async () => {
                const username = `e2e_new_${label.length}_${run}`;
                const res = await request(app.getHttpServer()).post(api(path)).set(auth('admin')).send(userBody(username, 99999));

                expect(res.status).toBe(400);
                expect(res.body.error).toBe('INVALID_ROLE');
                expect(res.body.message).toBe('The given role does not exist.');
                expect(await userCount(username)).toBe(0);
            });
        }

        it('con un rol real sigue creando (201)', async () => {
            const username = `e2e_new_ok_${run}`;
            const res = await request(app.getHttpServer()).post(api('/users')).set(auth('admin')).send(userBody(username, roleIds.driver));

            expect(res.status).toBe(201);
            expect(res.body.role.name).toBe('driver');
        });

        it('PATCH /users/:id/role con un roleId que no existe → 400 y el usuario queda igual', async () => {
            const [{ user_id, role_id }] = await dataSource.query(`SELECT user_id, role_id FROM users WHERE username = $1`, [`e2e_rs_supervisor_${run}`]);

            const res = await request(app.getHttpServer()).patch(api(`/users/${user_id}/role`)).set(auth('admin')).send({ roleId: 99999 });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_ROLE');
            const [row] = await dataSource.query(`SELECT role_id FROM users WHERE user_id = $1`, [user_id]);
            expect(row).toEqual({ role_id });
        });

        it('PATCH /users/:id/role con un rol real lo cambia', async () => {
            const [{ user_id }] = await dataSource.query(`SELECT user_id FROM users WHERE username = $1`, [`e2e_rs_supervisor_${run}`]);
            const res = await request(app.getHttpServer()).patch(api(`/users/${user_id}/role`)).set(auth('admin')).send({ roleId: roleIds.supervisor });
            expect(res.status).toBe(200);
        });

        it('un roleId de tipo inválido sigue siendo el 400 de validación', async () => {
            const res = await request(app.getHttpServer()).post(api('/users')).set(auth('admin')).send(userBody(`e2e_new_bad_${run}`, 'x'));
            expect(res.status).toBe(400);
            expect(Array.isArray(res.body.message)).toBe(true);
        });
    });

    describe('la búsqueda trata % y _ como texto', () => {
        it('roles: "%" y "_" no listan todos los roles', async () => {
            for (const term of ['%', '_']) {
                const res = await request(app.getHttpServer()).get(api(`/roles?search=${encodeURIComponent(term)}`)).set(auth('admin'));
                expect(res.status).toBe(200);
                expect(res.body.data, term).toEqual([]);
            }
            const ok = await request(app.getHttpServer()).get(api('/roles?search=ADM')).set(auth('admin'));
            expect(ok.body.data.map((r: any) => r.name)).toEqual(['admin']);
        });

        it('delivery zones: "50%" encuentra solo la zona con ese texto', async () => {
            for (const [code, name] of [[`RS${run}A`, 'Zona 50% off'], [`RS${run}B`, 'Zona 500 off'], [`RS${run}C`, 'Zona a_b'], [`RS${run}D`, 'Zona axb']]) {
                expect((await request(app.getHttpServer()).post(api('/delivery-zones')).set(auth('coordinator')).send({ code, name, estimatedTimeMin: 30 })).status).toBe(201);
            }
            const names = async (term: string) => (await request(app.getHttpServer()).get(api(`/delivery-zones?search=${encodeURIComponent(term)}`)).set(auth('coordinator'))).body.data.map((z: any) => z.name);

            expect(await names('Zona 50%')).toEqual(['Zona 50% off']);
            expect(await names('Zona a_b')).toEqual(['Zona a_b']);
            expect(await names('%')).toEqual(['Zona 50% off']);
        });

        it('vehicles: "50%" encuentra solo el vehículo con ese texto', async () => {
            const make = (plate: string, model: string) => request(app.getHttpServer()).post(api('/vehicles')).set(auth('supervisor'))
                .send({ type: 'camioneta', model, plate, capacityKg: 100, capacityM3: 1 });
            expect((await make(`RS${run}1`, 'Modelo 50% x')).status).toBe(201);
            expect((await make(`RS${run}2`, 'Modelo 500 x')).status).toBe(201);
            const models = async (term: string) => (await request(app.getHttpServer()).get(api(`/vehicles?search=${encodeURIComponent(term)}`)).set(auth('supervisor'))).body.data.map((v: any) => v.model);

            expect(await models('Modelo 50%')).toEqual(['Modelo 50% x']);
            expect(await models('50%')).toEqual(['Modelo 50% x']);
        });
    });
});
