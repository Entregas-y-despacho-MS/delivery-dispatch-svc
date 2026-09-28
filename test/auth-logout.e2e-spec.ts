// ES-34 (ST-34.3) — Cierre de sesión (RF-U08). El backend ya existía (POST /auth/logout, del
// trabajo de hardening de auth) y ya lo consume esta historia sin cambios — esta subtarea es
// "Backend Integration: Consumo de POST /auth/logout" del lado del repartidor, no una construcción
// nueva. Este archivo consolida en un solo lugar el contrato completo que el equipo móvil necesita
// (antes estaba repartido como casos sueltos en protected-endpoints y security-hardening), como
// referencia de integración y para dejar el comportamiento realmente verificado.
//
// Los Escenarios 2 y 3 de la historia (destruir el Foreground Service de GPS, la notificación
// persistente, y la alerta de eventos offline sin sincronizar) son enteramente de la app móvil —
// nada de eso pasa por el backend, no se cubre acá.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest.
// Autolimpiante (tag único por corrida), seguro de re-correr contra una base compartida.
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

describe('Cierre de sesión — POST /auth/logout (e2e, RF-U08)', () => {
    let app: INestApplication;
    let ds: DataSource;
    let apiPrefix: string;
    const roles: Record<string, number> = {};
    const run = Date.now().toString(36).toUpperCase();

    const api = (p: string) => `/${apiPrefix}${p}`;
    const http = () => request(app.getHttpServer());
    const login = (username: string) => http().post(api('/auth/login')).send({ username, password: PASSWORD });
    const logout = (accessToken: string) => http().post(api('/auth/logout')).set({ Authorization: `Bearer ${accessToken}` });
    const mkUser = async (role: string, tag: string, extra: { requiresPwdChange?: boolean } = {}) => {
        const username = `e2e_lo_${tag}_${run}`;
        const [{ user_id }] = await ds.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, $5) RETURNING user_id`,
            [roles[role], `E2E ${tag}`, username, await hashPassword(PASSWORD), extra.requiresPwdChange ?? false],
        );
        return { id: user_id as number, username };
    };
    const refreshTokenHash = async (userId: number) => (await ds.query(`SELECT refresh_token_hash FROM users WHERE user_id = $1`, [userId]))[0].refresh_token_hash as string | null;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

        // Same bootstrap as main.ts — the 204/401 shape and route prefix depend on it.
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
        for (const r of await ds.query(`SELECT role_id, name FROM roles`)) roles[r.name] = r.role_id;
    });

    afterAll(async () => {
        await ds.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_lo_%_${run}`]);
        await app.close();
    });

    // ── Escenario 1 — cierre de sesión exitoso y purga segura ────────────────────
    describe('Escenario 1 — el backend revoca la sesión de verdad', () => {
        it('204, y el refresh_token_hash queda en NULL en la base', async () => {
            const u = await mkUser('driver', 'basic');
            const l = await login(u.username);

            const res = await logout(l.body.accessToken);

            expect(res.status).toBe(204);
            expect(await refreshTokenHash(u.id)).toBeNull();
        });

        it('el refresh token de ANTES del logout ya no sirve para renovar la sesión', async () => {
            const u = await mkUser('driver', 'refresh');
            const l = await login(u.username);
            await logout(l.body.accessToken);

            const res = await http().post(api('/auth/refresh')).send({ refreshToken: l.body.refreshToken });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('INVALID_REFRESH_TOKEN');
        });

        it('el access token usado para desloguearse sigue funcionando hasta que expira solo (JWT sin estado — comportamiento esperado, no un bug)', async () => {
            const u = await mkUser('driver', 'access');
            const l = await login(u.username);
            await logout(l.body.accessToken);

            // change-password no tiene @Roles() (cualquier autenticado) — una contraseña actual
            // equivocada da 401 INVALID_CREDENTIALS solo si el guard de JWT ya dejó pasar el
            // access token. Si el logout lo hubiera invalidado, esto sería 401 INVALID_TOKEN.
            const res = await http().patch(api('/auth/change-password'))
                .set({ Authorization: `Bearer ${l.body.accessToken}` })
                .send({ currentPassword: 'wrong-on-purpose', newPassword: 'Whatever123!' });

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('INVALID_CREDENTIALS');
        });
    });

    // ── "Cualquier repartidor en ruta" — sin restricción de rol ──────────────────
    describe('cualquier rol autenticado puede cerrar su propia sesión', () => {
        it.each(['driver', 'coordinator', 'supervisor', 'admin', 'root'])('%s → 204', async (role) => {
            const u = await mkUser(role, `role_${role}`);
            const l = await login(u.username);

            expect((await logout(l.body.accessToken)).status).toBe(204);
        });
    });

    // ── Sin sesión activa ─────────────────────────────────────────────────────────
    describe('sin token', () => {
        it('401, no se puede desloguear sin estar logueado', async () => {
            expect((await http().post(api('/auth/logout'))).status).toBe(401);
        });

        it('un token inválido/manipulado → 401', async () => {
            expect((await logout('esto-no-es-un-jwt')).status).toBe(401);
        });
    });

    // ── Con cambio de contraseña pendiente (RF-A25) ───────────────────────────────
    describe('funciona incluso con cambio de contraseña obligatorio pendiente', () => {
        it('204 — logout es una de las dos rutas permitidas mientras mustChangePassword es true', async () => {
            const u = await mkUser('driver', 'mustchange', { requiresPwdChange: true });
            const l = await login(u.username);
            expect(l.body.mustChangePassword).toBe(true);

            expect((await logout(l.body.accessToken)).status).toBe(204);
        });
    });

    // ── Idempotencia (doble tap del botón) ────────────────────────────────────────
    describe('doble tap del botón de cerrar sesión', () => {
        it('dos logouts seguidos con el mismo access token → 204 las dos veces, sin error', async () => {
            const u = await mkUser('driver', 'doubletap');
            const l = await login(u.username);

            const first  = await logout(l.body.accessToken);
            const second = await logout(l.body.accessToken);

            expect(first.status).toBe(204);
            expect(second.status).toBe(204);
            expect(await refreshTokenHash(u.id)).toBeNull();
        });
    });
});
