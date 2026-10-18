// ES-36 (ST-36.3) — Persistencia de push tokens (RF-U10). Dos niveles contra la base real:
//   1. PushTokensRepository directo: un registro repetido no duplica, la revocación saca el token de
//      los activos, un teléfono compartido no deja el token activo en dos usuarios.
//   2. PUT / DELETE /push-tokens/:deviceId por HTTP: roles, validación y el logout con cambio de
//      contraseña pendiente.
//
// Levanta el AppModule real contra una base de datos real (con la migración 019 aplicada) y pega por
// HTTP con supertest. Autolimpiante (tag único por corrida): borrar el usuario borra sus tokens en cascada.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { PushTokensRepository } from '../src/modules/auth/push-tokens/repositories/push-tokens.repository.js';
import { PushPlatformEnum } from '../src/modules/auth/push-tokens/enums/push-platform.enum.js';

const PASSWORD = 'E2eTest1234';

describe('Push tokens (e2e, RF-U10)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let repository: PushTokensRepository;
    let apiPrefix: string;
    const roles: Record<string, number> = {};
    const run = Date.now().toString(36).toUpperCase();
    let seq = 0;

    const api = (p: string) => `/${apiPrefix}${p}`;
    const http = () => request(app.getHttpServer());
    const tokenOf = (label: string) => `ExponentPushToken[e2e-${label}-${run}-${++seq}]`;
    const mkUser = async (role: string, tag: string, extra: { requiresPwdChange?: boolean } = {}) => {
        const username = `e2e_pt_${tag}_${run}`;
        const [{ user_id }] = await ds.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
            [roles[role], `E2E ${tag}`, username, await hashPassword(PASSWORD), extra.requiresPwdChange ?? false],
        );
        return { id: user_id as number, username };
    };
    const bearer = async (username: string) => {
        const l = await http().post(api('/auth/login')).send({ username, password: PASSWORD });
        return { Authorization: `Bearer ${l.body.accessToken}` };
    };
    const rows = async (userId: number) =>
        await ds.query(`SELECT device_id, token, platform, revoked_at FROM push_tokens WHERE user_id = $1 ORDER BY device_id`, [userId]);
    const put = (deviceId: string, headers: object, body: object) => http().put(api(`/push-tokens/${deviceId}`)).set(headers).send(body);
    const del = (deviceId: string, headers: object) => http().delete(api(`/push-tokens/${deviceId}`)).set(headers);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

        // Same bootstrap as main.ts — the 204/400 shape and route prefix depend on it.
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
        repository = moduleRef.get(PushTokensRepository);
        for (const r of await ds.query(`SELECT role_id, name FROM roles`)) roles[r.name] = r.role_id;
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_pt_%_${run}`]);
        await app.close();
    });

    // ── Repositorio contra Postgres real ──────────────────────────────────────────
    describe('PushTokensRepository', () => {
        it('un registro repetido del mismo dispositivo no duplica: actualiza la misma fila', async () => {
            const u = await mkUser('driver', 'repo_dup');
            const first = await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('a'), platform: PushPlatformEnum.ANDROID });
            const second = await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('b'), platform: PushPlatformEnum.IOS });

            const stored = await rows(u.id);
            expect(stored).toHaveLength(1);
            expect(second.id).toBe(first.id);
            expect(stored[0]).toMatchObject({ token: second.token, platform: 'ios', revoked_at: null });
            expect(second.lastUsedAt.getTime()).toBeGreaterThanOrEqual(first.lastUsedAt.getTime());
        });

        it('la revocación excluye el token de los activos pero conserva la fila', async () => {
            const u = await mkUser('driver', 'repo_revoke');
            await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('a'), platform: PushPlatformEnum.ANDROID });
            await repository.register({ userId: u.id, deviceId: 'd2', token: tokenOf('b'), platform: PushPlatformEnum.IOS });
            expect(await repository.findActiveByUserId(u.id)).toHaveLength(2);

            expect(await repository.revokeByDevice(u.id, 'd1')).toBe(1);

            const active = await repository.findActiveByUserId(u.id);
            expect(active.map((t) => t.deviceId)).toEqual(['d2']);
            const stored = await rows(u.id);
            expect(stored).toHaveLength(2);
            expect(stored.find((r: any) => r.device_id === 'd1').revoked_at).not.toBeNull();
        });

        it('revocar lo que ya está revocado, o un dispositivo que no existe, no revoca nada', async () => {
            const u = await mkUser('driver', 'repo_idem');
            await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('a'), platform: PushPlatformEnum.ANDROID });

            expect(await repository.revokeByDevice(u.id, 'd1')).toBe(1);
            expect(await repository.revokeByDevice(u.id, 'd1')).toBe(0);
            expect(await repository.revokeByDevice(u.id, 'nunca-registrado')).toBe(0);
        });

        it('registrar de nuevo un dispositivo revocado lo reactiva', async () => {
            const u = await mkUser('driver', 'repo_react');
            await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('a'), platform: PushPlatformEnum.ANDROID });
            await repository.revokeByDevice(u.id, 'd1');

            await repository.register({ userId: u.id, deviceId: 'd1', token: tokenOf('b'), platform: PushPlatformEnum.ANDROID });

            expect(await repository.findActiveByUserId(u.id)).toHaveLength(1);
            expect(await rows(u.id)).toHaveLength(1);
        });

        it('teléfono compartido: el segundo usuario se queda con el token y el primero deja de recibirlo', async () => {
            const a = await mkUser('driver', 'repo_shared_a');
            const b = await mkUser('driver', 'repo_shared_b');
            const shared = tokenOf('phone');
            await repository.register({ userId: a.id, deviceId: 'phone', token: shared, platform: PushPlatformEnum.ANDROID });

            await repository.register({ userId: b.id, deviceId: 'phone', token: shared, platform: PushPlatformEnum.ANDROID });

            expect(await repository.findActiveByUserId(a.id)).toHaveLength(0);
            expect((await repository.findActiveByUserId(b.id)).map((t) => t.token)).toEqual([shared]);
        });

        it('revokeByToken revoca el token activo sea quien sea su dueño (token rechazado por el proveedor)', async () => {
            const u = await mkUser('driver', 'repo_bytoken');
            const t = tokenOf('dead');
            await repository.register({ userId: u.id, deviceId: 'd1', token: t, platform: PushPlatformEnum.IOS });

            expect(await repository.revokeByToken(t)).toBe(1);
            expect(await repository.findActiveByUserId(u.id)).toHaveLength(0);
        });

        it('la base rechaza lo que el repositorio nunca generaría: duplicado, token activo repetido y plataforma inválida', async () => {
            const a = await mkUser('driver', 'db_a');
            const b = await mkUser('driver', 'db_b');
            const t = tokenOf('db');
            const insert = (userId: number, deviceId: string, token: string, platform = 'ios') =>
                ds.query(`INSERT INTO push_tokens (user_id, device_id, token, platform) VALUES ($1, $2, $3, $4)`, [userId, deviceId, token, platform]);
            await insert(a.id, 'd1', t);

            await expect(insert(a.id, 'd1', tokenOf('other'))).rejects.toMatchObject({ driverError: { code: '23505', constraint: 'uq_push_tokens_user_device' } });
            await expect(insert(b.id, 'd9', t)).rejects.toMatchObject({ driverError: { code: '23505', constraint: 'uq_push_tokens_active_token' } });
            await expect(insert(b.id, 'd9', tokenOf('web'), 'web')).rejects.toMatchObject({ driverError: { code: '23514' } });
        });
    });

    // ── HTTP ──────────────────────────────────────────────────────────────────────
    describe('PUT /push-tokens/:deviceId', () => {
        it('204 y queda registrado para el usuario del JWT; repetirlo no duplica', async () => {
            const u = await mkUser('driver', 'put_ok');
            const h = await bearer(u.username);
            const first = tokenOf('a');

            expect((await put('device-1', h, { token: first, platform: 'android' })).status).toBe(204);
            expect((await put('device-1', h, { token: first, platform: 'android' })).status).toBe(204);

            const stored = await rows(u.id);
            expect(stored).toHaveLength(1);
            expect(stored[0]).toMatchObject({ device_id: 'device-1', token: first, platform: 'android', revoked_at: null });
        });

        it('cuando el token cambia, la misma fila guarda el nuevo', async () => {
            const u = await mkUser('driver', 'put_rotate');
            const h = await bearer(u.username);
            const next = tokenOf('next');
            await put('device-1', h, { token: tokenOf('old'), platform: 'ios' });

            await put('device-1', h, { token: next, platform: 'ios' });

            const stored = await rows(u.id);
            expect(stored).toHaveLength(1);
            expect(stored[0].token).toBe(next);
        });

        it('teléfono compartido por HTTP: el token pasa al segundo repartidor', async () => {
            const a = await mkUser('driver', 'put_shared_a');
            const b = await mkUser('driver', 'put_shared_b');
            const shared = tokenOf('shared');
            await put('phone', await bearer(a.username), { token: shared, platform: 'android' });

            expect((await put('phone', await bearer(b.username), { token: shared, platform: 'android' })).status).toBe(204);

            expect(await repository.findActiveByUserId(a.id)).toHaveLength(0);
            expect(await repository.findActiveByUserId(b.id)).toHaveLength(1);
        });

        it.each([
            ['plataforma inválida', { token: 'abc', platform: 'web' }],
            ['token vacío', { token: '', platform: 'ios' }],
            ['sin body', {}],
            ['token de más de 255 caracteres', { token: 'a'.repeat(256), platform: 'ios' }],
            ['el dueño no se puede mandar en el body', { token: 'abc', platform: 'ios', userId: 1 }],
        ])('400 — %s', async (_name, body) => {
            const u = await mkUser('driver', `put_400_${++seq}`);
            const res = await put('device-1', await bearer(u.username), body);

            expect(res.status).toBe(400);
            expect(await rows(u.id)).toHaveLength(0);
        });

        it('400 — deviceId de más de 100 caracteres', async () => {
            const u = await mkUser('driver', 'put_longdevice');
            const res = await put('d'.repeat(101), await bearer(u.username), { token: tokenOf('a'), platform: 'ios' });

            expect(res.status).toBe(400);
        });

        it('401 sin token; 403 para quien no es repartidor', async () => {
            const body = { token: tokenOf('a'), platform: 'ios' };
            expect((await http().put(api('/push-tokens/device-1')).send(body)).status).toBe(401);

            const c = await mkUser('coordinator', 'put_coord');
            const res = await put('device-1', await bearer(c.username), body);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        });

        it('403 PASSWORD_CHANGE_REQUIRED mientras el cambio de contraseña está pendiente', async () => {
            const u = await mkUser('driver', 'put_mustchange', { requiresPwdChange: true });
            const res = await put('device-1', await bearer(u.username), { token: tokenOf('a'), platform: 'ios' });

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('PASSWORD_CHANGE_REQUIRED');
        });
    });

    describe('DELETE /push-tokens/:deviceId', () => {
        it('204 y el token queda revocado: ya no figura entre los activos', async () => {
            const u = await mkUser('driver', 'del_ok');
            const h = await bearer(u.username);
            await put('device-1', h, { token: tokenOf('a'), platform: 'android' });

            expect((await del('device-1', h)).status).toBe(204);

            expect(await repository.findActiveByUserId(u.id)).toHaveLength(0);
            expect((await rows(u.id))[0].revoked_at).not.toBeNull();
        });

        it('204 también si ya estaba revocado o el dispositivo nunca se registró (el logout nunca se bloquea)', async () => {
            const u = await mkUser('driver', 'del_idem');
            const h = await bearer(u.username);
            await put('device-1', h, { token: tokenOf('a'), platform: 'android' });
            await del('device-1', h);

            expect((await del('device-1', h)).status).toBe(204);
            expect((await del('nunca-registrado', h)).status).toBe(204);
        });

        it('solo revoca el dispositivo del propio usuario, nunca el de otro', async () => {
            const a = await mkUser('driver', 'del_own_a');
            const b = await mkUser('driver', 'del_own_b');
            await put('same-id', await bearer(a.username), { token: tokenOf('a'), platform: 'ios' });
            await put('same-id', await bearer(b.username), { token: tokenOf('b'), platform: 'ios' });

            await del('same-id', await bearer(a.username));

            expect(await repository.findActiveByUserId(a.id)).toHaveLength(0);
            expect(await repository.findActiveByUserId(b.id)).toHaveLength(1);
        });

        it('204 aunque el cambio de contraseña esté pendiente: el repartidor puede cerrar sesión', async () => {
            const u = await mkUser('driver', 'del_mustchange', { requiresPwdChange: true });
            const res = await del('device-1', await bearer(u.username));

            expect(res.status).toBe(204);
        });

        it('401 sin token; 403 para quien no es repartidor', async () => {
            expect((await http().delete(api('/push-tokens/device-1'))).status).toBe(401);

            const c = await mkUser('coordinator', 'del_coord');
            expect((await del('device-1', await bearer(c.username))).status).toBe(403);
        });
    });
});
