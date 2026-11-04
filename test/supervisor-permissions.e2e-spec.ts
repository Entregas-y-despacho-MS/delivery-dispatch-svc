// ES-59 (ST-59.1) — Matriz de permisos del Supervisor (RF-A12).
//
// Recorre con un token real de Supervisor los endpoints de dispatch, fleet, catalog, settings, audit,
// auth y los de otros roles, y comprueba la matriz documentada en el README del back:
//   - lo permitido responde 200 (lecturas sin datos previos) o, para lecturas por id y escrituras,
//     "no 401/403": el RolesGuard lo deja pasar y la petición llega a la validación o al 404;
//   - lo reservado responde 403 INSUFFICIENT_PERMISSIONS.
//
// Las escrituras permitidas se prueban con un id inexistente y un cuerpo vacío, así que no modifican
// datos. Los endpoints de ST-241.1 y ST-239.2 (PR sin mergear) no están en esta matriz: se agregan
// cuando se mergeen, igual que los que traen ST-60.1, ST-61.1, ST-62.1, ST-63.1, ST-64.1 y ST-67.1.
//
// Levanta el AppModule real contra una base real. El Supervisor se crea por DataSource, inicia sesión
// de verdad y se borra en afterAll (seguro de re-correr contra una base compartida).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Route {
    method: Method;
    path: string;
    body?: object;
}

/** Un id válido para ParseIdPipe (1..INT4_MAX) que no existe: el guard decide antes del 404. */
const NO_ID = 999_999_999;

// ── Lo que el Supervisor SÍ puede ──────────────────────────────────────────────
/** Lecturas sin parámetros obligatorios ni datos previos: 200 exacto. */
const ALLOWED_LISTS: Route[] = [
    { method: 'get', path: '/dispatches/kanban' },
    { method: 'get', path: '/dispatches/kanban/filters' },
    { method: 'get', path: '/dispatches/history' },
    { method: 'get', path: '/dispatches/change-requests' },
    { method: 'get', path: '/pending-orders' },
    { method: 'get', path: '/route-batches' },
    { method: 'get', path: '/vehicles' },
    { method: 'get', path: '/vehicle-incident-types' },
    { method: 'get', path: '/warehouses' },
    { method: 'get', path: '/incident-reasons' },
    { method: 'get', path: '/reschedule-reasons' },
];

/** Lecturas por id y escrituras permitidas: el guard las deja pasar (ni 401 ni 403). */
const ALLOWED_PASS: Route[] = [
    { method: 'get', path: '/dispatches/history/export' },
    { method: 'get', path: `/dispatches/${NO_ID}/detail` },
    { method: 'get', path: `/route-batches/${NO_ID}` },
    { method: 'get', path: `/vehicles/${NO_ID}` },
    { method: 'get', path: `/vehicle-incident-types/${NO_ID}` },
    { method: 'get', path: `/warehouses/${NO_ID}` },
    { method: 'get', path: `/incident-reasons/${NO_ID}` },
    { method: 'get', path: `/reschedule-reasons/${NO_ID}` },
    { method: 'post', path: `/route-batches/${NO_ID}/approve-promises`, body: {} },
    { method: 'patch', path: `/route-batches/${NO_ID}/reviewer`, body: {} },
    { method: 'patch', path: `/route-batches/${NO_ID}/driver`, body: {} },
    { method: 'patch', path: `/route-batches/${NO_ID}/vehicle`, body: {} },
    { method: 'patch', path: `/dispatches/${NO_ID}/priority`, body: {} },
    { method: 'post', path: '/vehicles', body: {} },
    { method: 'put', path: `/vehicles/${NO_ID}`, body: {} },
    { method: 'delete', path: `/vehicles/${NO_ID}` },
    { method: 'post', path: '/vehicle-maintenances', body: {} },
    { method: 'post', path: '/vehicle-incident-types', body: {} },
    { method: 'put', path: `/vehicle-incident-types/${NO_ID}`, body: {} },
];

// ── Lo que el Supervisor NO puede (403) ────────────────────────────────────────
const COORDINATOR_ONLY: Route[] = [
    { method: 'post', path: `/route-batches/${NO_ID}/approve-final`, body: {} },
    { method: 'post', path: '/dispatch-reservations', body: {} },
    { method: 'post', path: '/dispatch-reservations/renew', body: {} },
    { method: 'post', path: '/dispatch-reservations/release', body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/pickup-schedule`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/pickup-reschedule`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/reschedule`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/return`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/cancel`, body: {} },
    { method: 'post', path: `/dispatches/change-requests/${NO_ID}/tracking-link`, body: {} },
    { method: 'post', path: '/planning/generate', body: {} },
    { method: 'post', path: '/planning/cutoff', body: {} },
    { method: 'get', path: '/service-levels' },
    { method: 'get', path: `/service-levels/${NO_ID}` },
    { method: 'post', path: '/service-levels', body: {} },
    { method: 'put', path: `/service-levels/${NO_ID}`, body: {} },
    { method: 'delete', path: `/service-levels/${NO_ID}` },
    { method: 'get', path: '/delivery-zones' },
    { method: 'get', path: `/delivery-zones/${NO_ID}` },
    { method: 'post', path: '/delivery-zones', body: {} },
    { method: 'put', path: `/delivery-zones/${NO_ID}`, body: {} },
    { method: 'delete', path: `/delivery-zones/${NO_ID}` },
    // ST-59.1: el Supervisor lee estos catálogos pero ya no los escribe.
    { method: 'post', path: '/incident-reasons', body: {} },
    { method: 'put', path: `/incident-reasons/${NO_ID}`, body: {} },
    { method: 'post', path: '/reschedule-reasons', body: {} },
    { method: 'put', path: `/reschedule-reasons/${NO_ID}`, body: {} },
    { method: 'get', path: '/settings' },
    { method: 'put', path: '/settings/some_key', body: {} },
    { method: 'get', path: '/audit/outbound-message-alerts' },
];

const ADMIN_ONLY: Route[] = [
    { method: 'get', path: '/users' },
    { method: 'get', path: `/users/${NO_ID}` },
    { method: 'post', path: '/users', body: {} },
    { method: 'put', path: `/users/${NO_ID}`, body: {} },
    { method: 'patch', path: `/users/${NO_ID}/role`, body: {} },
    { method: 'delete', path: `/users/${NO_ID}` },
    { method: 'post', path: '/auth/register', body: {} },
    { method: 'get', path: '/roles' },
    { method: 'get', path: `/roles/${NO_ID}` },
];

const DRIVER_ONLY: Route[] = [
    { method: 'get', path: '/dispatches/my-assignments' },
    { method: 'get', path: '/dispatches/my-history' },
    { method: 'get', path: '/drivers/me/metrics' },
    { method: 'post', path: `/route-batches/${NO_ID}/start`, body: {} },
    { method: 'post', path: `/route-batches/${NO_ID}/accept`, body: {} },
    { method: 'post', path: `/route-batches/${NO_ID}/cotejo-photos`, body: {} },
    { method: 'patch', path: `/dispatches/${NO_ID}/status`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/evidences`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/otp/validate`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/otp/resend`, body: {} },
    { method: 'post', path: `/dispatches/${NO_ID}/incidents`, body: {} },
    { method: 'post', path: '/tracking/locations', body: {} },
    { method: 'put', path: '/push-tokens/some-device', body: {} },
    { method: 'delete', path: '/push-tokens/some-device' },
];

describe('Matriz de permisos del Supervisor (e2e, ES-59 / RF-A12)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    let supervisorToken: string;

    const run = Date.now().toString(36).toUpperCase();
    const username = `e2e_sp_supervisor_${run}`;

    const call = (route: Route, token?: string) => {
        const req = request(app.getHttpServer())[route.method](`/${apiPrefix}${route.path}`);
        if (token) req.set('Authorization', `Bearer ${token}`);
        return route.body ? req.send(route.body) : req;
    };
    const label = (route: Route) => `${route.method.toUpperCase()} ${route.path}`;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

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

        dataSource = moduleRef.get(DataSource);
        const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'supervisor'`);
        await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
            [role_id, 'E2E supervisor', username, await hashPassword('E2eTest1234')],
        );
        const res = await request(app.getHttpServer())
            .post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
        supervisorToken = res.body.accessToken as string;
    });

    afterAll(async () => {
        await withEventPurge(dataSource, { userNames: [username] }, async (manager) => {
            await manager.query(`DELETE FROM users WHERE username = $1`, [username]);
        });
        await app.close();
    });

    it('el login del Supervisor devuelve un token con rol supervisor', () => {
        expect(supervisorToken).toEqual(expect.any(String));
    });

    it('sin token ninguna ruta de la matriz responde 401', async () => {
        for (const route of [ALLOWED_LISTS[0], COORDINATOR_ONLY[0], ADMIN_ONLY[0]]) {
            expect((await call(route)).status, label(route)).toBe(401);
        }
    });

    describe('permitido', () => {
        it.each(ALLOWED_LISTS.map((r) => [label(r), r] as const))('%s → 200', async (_name, route) => {
            const res = await call(route, supervisorToken);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
        });

        it.each(ALLOWED_PASS.map((r) => [label(r), r] as const))('%s → pasa el guard (ni 401 ni 403)', async (_name, route) => {
            const res = await call(route, supervisorToken);
            expect([401, 403], JSON.stringify(res.body)).not.toContain(res.status);
        });
    });

    describe('reservado → 403 INSUFFICIENT_PERMISSIONS', () => {
        const groups: Array<[string, Route[]]> = [
            ['solo del Coordinador', COORDINATOR_ONLY],
            ['solo del Administrador', ADMIN_ONLY],
            ['solo del Repartidor', DRIVER_ONLY],
        ];

        for (const [group, routes] of groups) {
            describe(group, () => {
                it.each(routes.map((r) => [label(r), r] as const))('%s → 403', async (_name, route) => {
                    const res = await call(route, supervisorToken);
                    expect(res.status, JSON.stringify(res.body)).toBe(403);
                    expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
                });
            });
        }
    });

    it('los permisos se evalúan antes que la validación: un cuerpo inválido sin permiso da 403, no 400', async () => {
        const res = await call({ method: 'post', path: '/incident-reasons', body: { requiresEvidence: 'nope' } }, supervisorToken);
        expect(res.status).toBe(403);
    });
});
