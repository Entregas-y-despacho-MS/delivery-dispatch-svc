// ES-4 (ST-19.1 + ST-19.3) — PATCH /users/:id/role (RF-A27): asignación/modificación de rol,
// protección contra auto-degradación, y revocación de sesión para forzar el rol nuevo en el
// próximo login.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest.
// Complementa a los unitarios (sin DB) de src/modules/auth/users/. Los casos generales de
// protección de root/cuenta propia ya están cubiertos en test/security-hardening.e2e-spec.ts;
// acá se prueba específicamente el endpoint dedicado y la revocación de sesión.
//
// Seguro de re-correr contra una base compartida: usuarios de prueba con prefijo único por
// corrida, borrados en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

const PASSWORD = 'E2eTest1234';

describe('Cambio de rol (e2e, RF-A27)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const roleId: Record<string, number> = {};

    const run = Date.now().toString(36).toUpperCase();
    const api = (p = '') => `/${apiPrefix}${p}`;
    const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
    const login = (username: string, password = PASSWORD) => request(app.getHttpServer()).post(api('/auth/login')).send({ username, password });
    const patchRole = (id: number, body: object, who = 'admin') => request(app.getHttpServer()).patch(api(`/users/${id}/role`)).set(auth(who)).send(body);
    const mkUser = async (role: string, tag: string) => {
        const username = `ur_${tag}_${run}`;
        const [{ user_id }] = await ds.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false) RETURNING user_id`,
            [roleId[role], `UR ${tag}`, username, await hashPassword(PASSWORD)],
        );
        return { id: user_id as number, username };
    };
    const userRow = async (id: number) => (await ds.query(`SELECT * FROM users WHERE user_id = $1`, [id]))[0];

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        ds = moduleRef.get(DataSource);
        for (const r of await ds.query(`SELECT role_id, name FROM roles`)) roleId[r.name] = r.role_id;
        for (const role of ['admin', 'coordinator']) {
            await ds.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,$2,$3,$4,false)`, [roleId[role], `UR base ${role}`, `ur_base_${role}_${run}`, await hashPassword(PASSWORD)]);
            tokens[role] = (await login(`ur_base_${role}_${run}`)).body.accessToken;
        }
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM users WHERE username LIKE $1`, [`ur\\_%\\_${run}`]);
        await app.close();
    });

    // ── Escenario 1 ────────────────────────────────────────────────────────────
    describe('Escenario 1 — modificación exitosa de rol', () => {
        it('el ejemplo de la historia: de driver a supervisor → 200, el rol cambia de inmediato en la base', async () => {
            const u = await mkUser('driver', 'e1');
            const res = await patchRole(u.id, { roleId: roleId.supervisor });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id: u.id, role: { id: roleId.supervisor, name: 'supervisor' } });
            expect((await userRow(u.id)).role_id).toBe(roleId.supervisor);
        });

        it('se invalidan los tokens de sesión previos: el refresh token deja de servir y hay que iniciar sesión de nuevo', async () => {
            const u = await mkUser('driver', 'e2');
            const before = await login(u.username);
            const oldRefresh = before.body.refreshToken as string;
            expect((await userRow(u.id)).refresh_token_hash).not.toBeNull();

            await patchRole(u.id, { roleId: roleId.supervisor }).expect(200);

            expect((await userRow(u.id)).refresh_token_hash).toBeNull();
            const refreshAttempt = await request(app.getHttpServer()).post(api('/auth/refresh')).send({ refreshToken: oldRefresh });
            expect(refreshAttempt.status).toBe(401);

            // el próximo login sí emite el rol nuevo
            const after = await login(u.username);
            expect(after.status).toBe(200);
            expect(after.body.user.role.name).toBe('supervisor');
        });

        it('el rol cambiado aplica de inmediato en la siguiente petición, sin esperar a que expire el access token', async () => {
            const u = await mkUser('driver', 'e3');
            const token = (await login(u.username)).body.accessToken as string;
            const before = await request(app.getHttpServer()).get(api('/vehicles')).set({ Authorization: `Bearer ${token}` });
            expect(before.status).toBe(403); // driver no puede leer vehicles

            await patchRole(u.id, { roleId: roleId.supervisor }).expect(200);

            const afterRes = await request(app.getHttpServer()).get(api('/vehicles')).set({ Authorization: `Bearer ${token}` });
            expect(afterRes.status).toBe(200); // supervisor sí puede, con el MISMO token viejo
        });

        it('enviar el mismo rol que ya tenía es un no-op: no revoca la sesión', async () => {
            const u = await mkUser('driver', 'e4');
            const before = await login(u.username);
            const hashBefore = (await userRow(u.id)).refresh_token_hash as string;

            const res = await patchRole(u.id, { roleId: roleId.driver });

            expect(res.status).toBe(200);
            expect((await userRow(u.id)).refresh_token_hash).toBe(hashBefore); // ni se tocó
            const stillWorks = await request(app.getHttpServer()).post(api('/auth/refresh')).send({ refreshToken: before.body.refreshToken });
            expect(stillWorks.status).toBe(200); // el refresh viejo sigue sirviendo
        });

        it('roleId inexistente → 400 INVALID_ROLE, el rol queda igual y no se revoca la sesión', async () => {
            const u = await mkUser('driver', 'e5');
            const before = await login(u.username);

            const res = await patchRole(u.id, { roleId: 99999999 });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_ROLE');
            expect((await userRow(u.id)).role_id).toBe(roleId.driver);
            expect((await request(app.getHttpServer()).post(api('/auth/refresh')).send({ refreshToken: before.body.refreshToken })).status).toBe(200);
        });

        it('un roleId inválido (no numérico, negativo, fuera de rango) → 400 de validación', async () => {
            const u = await mkUser('driver', 'e6');
            for (const roleIdValue of ['x', -1, 0, 1.5, null]) {
                expect((await patchRole(u.id, { roleId: roleIdValue })).status, String(roleIdValue)).toBe(400);
            }
        });

        it('roleId es obligatorio: un body vacío es 400, no un no-op', async () => {
            const u = await mkUser('driver', 'e7');
            expect((await patchRole(u.id, {})).status).toBe(400);
        });

        it('no acepta otros campos de usuario (whitelist): solo cambia el rol', async () => {
            const u = await mkUser('driver', 'e8');
            const res = await patchRole(u.id, { roleId: roleId.supervisor, fullName: 'Otro nombre' });
            expect(res.status).toBe(400);
        });

        it('usuario inexistente → 404 USER_NOT_FOUND', async () => {
            const res = await patchRole(99999999, { roleId: roleId.driver });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('USER_NOT_FOUND');
        });

        it(':id inválido (no numérico, 0, fuera de rango de INTEGER) → 400', async () => {
            for (const id of ['abc', '0', '-1', '99999999999']) {
                expect((await request(app.getHttpServer()).patch(api(`/users/${id}/role`)).set(auth('admin')).send({ roleId: roleId.driver })).status, id).toBe(400);
            }
        });
    });

    // ── Escenario 2 ────────────────────────────────────────────────────────────
    describe('Escenario 2 — protección contra auto-revocación', () => {
        it('un administrador no puede cambiar su propio rol, ni siquiera a otro rol administrativo', async () => {
            const admin = await mkUser('admin', 'self1');
            const H = { Authorization: `Bearer ${(await login(admin.username)).body.accessToken}` };

            const res = await request(app.getHttpServer()).patch(api(`/users/${admin.id}/role`)).set(H).send({ roleId: roleId.coordinator });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
            expect((await userRow(admin.id)).role_id).toBe(roleId.admin);
        });

        it('enviarse a sí mismo el mismo rol que ya tiene no cuenta como "degradarse": se permite (no-op)', async () => {
            const admin = await mkUser('admin', 'self2');
            const H = { Authorization: `Bearer ${(await login(admin.username)).body.accessToken}` };

            const res = await request(app.getHttpServer()).patch(api(`/users/${admin.id}/role`)).set(H).send({ roleId: roleId.admin });

            expect(res.status).toBe(200); // no revoca nada tampoco: no es un cambio real (probado en Escenario 1)
        });

        it('la protección de cuenta propia aplica incluso a root: tampoco puede cambiarse el rol a sí mismo', async () => {
            const [{ role_id: rootRoleId }] = await ds.query(`SELECT role_id FROM roles WHERE name = 'root'`);
            const root = await ds.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,'UR root',$2,$3,false) RETURNING user_id`, [rootRoleId, `ur_rootself_${run}`, await hashPassword(PASSWORD)]);
            const rootId = root[0].user_id;
            const H = { Authorization: `Bearer ${(await login(`ur_rootself_${run}`)).body.accessToken}` };

            const res = await request(app.getHttpServer()).patch(api(`/users/${rootId}/role`)).set(H).send({ roleId: roleId.admin });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
        });

        it('un admin sí puede cambiar el rol de OTRO admin (la protección es solo sobre la cuenta propia)', async () => {
            const victim = await mkUser('admin', 'other1');
            const res = await patchRole(victim.id, { roleId: roleId.coordinator }); // llamado por tokens.admin (otra cuenta)
            expect(res.status).toBe(200);
        });
    });

    // ── permisos ───────────────────────────────────────────────────────────────
    describe('permisos', () => {
        it('sin token → 401', async () => {
            const u = await mkUser('driver', 'perm1');
            expect((await request(app.getHttpServer()).patch(api(`/users/${u.id}/role`)).send({ roleId: roleId.supervisor })).status).toBe(401);
        });

        it('coordinator no puede cambiar roles (solo admin y root)', async () => {
            const u = await mkUser('driver', 'perm2');
            const res = await patchRole(u.id, { roleId: roleId.supervisor }, 'coordinator');
            expect(res.status).toBe(403);
            expect((await userRow(u.id)).role_id).toBe(roleId.driver);
        });

        it('root puede cambiar cualquier rol, incluido dar el rol root', async () => {
            const [{ role_id: rootRoleId }] = await ds.query(`SELECT role_id FROM roles WHERE name = 'root'`);
            await ds.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,'UR rootcaller',$2,$3,false)`, [rootRoleId, `ur_rootcaller_${run}`, await hashPassword(PASSWORD)]);
            const rootToken = (await login(`ur_rootcaller_${run}`)).body.accessToken;
            const u = await mkUser('driver', 'perm3');

            const res = await request(app.getHttpServer()).patch(api(`/users/${u.id}/role`)).set({ Authorization: `Bearer ${rootToken}` }).send({ roleId: rootRoleId });

            expect(res.status).toBe(200);
            expect(res.body.role.name).toBe('root');
        });

        it('un admin no puede dar el rol root a otro usuario (403 ROOT_ACCOUNT_PROTECTED)', async () => {
            const u = await mkUser('driver', 'perm4');
            const res = await patchRole(u.id, { roleId: roleId.root });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('ROOT_ACCOUNT_PROTECTED');
            expect((await userRow(u.id)).role_id).toBe(roleId.driver);
        });

        it('un admin no puede cambiar el rol de una cuenta que ya es root (403 ROOT_ACCOUNT_PROTECTED)', async () => {
            const [{ role_id: rootRoleId }] = await ds.query(`SELECT role_id FROM roles WHERE name = 'root'`);
            const root = await ds.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,'UR rootvictim',$2,$3,false) RETURNING user_id`, [rootRoleId, `ur_rootvictim_${run}`, await hashPassword(PASSWORD)]);

            const res = await patchRole(root[0].user_id, { roleId: roleId.driver });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('ROOT_ACCOUNT_PROTECTED');
        });
    });

    // ── general ────────────────────────────────────────────────────────────────
    describe('PUT /users/:id ya no admite roleId', () => {
        it('roleId en el body de PUT es un campo desconocido → 400', async () => {
            const u = await mkUser('driver', 'put1');
            const res = await request(app.getHttpServer()).put(api(`/users/${u.id}`)).set(auth('admin')).send({ roleId: roleId.supervisor });
            expect(res.status).toBe(400);
            expect((await userRow(u.id)).role_id).toBe(roleId.driver);
        });
    });
});
