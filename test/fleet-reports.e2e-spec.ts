// ST-65.1 — HTTP/PostgreSQL acceptance checks for GET /fleet/reports.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { fleetReportsCacheKey } from '../src/app/fleet-reports/domain/fleet-reports-cache-key.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver';

describe('GET /fleet/reports (e2e, ST-65.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let cache: CacheService;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const tag = `E2E651-${run}`;
    const from = '2026-06-01';
    const to = '2026-06-04';
    const plate = `${tag}-V`.slice(0, 15);
    const usernames = (['coordinator', 'supervisor', 'driver'] as const).map((role) => `e2e_st651_${role}_${run}`);
    let vehicleId = 0;
    const cacheKey = fleetReportsCacheKey(from, to);

    const get = (actor: Actor | null, range = { from, to }) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/fleet/reports`).query(range);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        dataSource = moduleRef.get(DataSource);
        cache = app.get(CacheService, { strict: false });
        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'driver'] as const) {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false)`,
                [roleId, `ST-65.1 ${role} ${run}`, `e2e_st651_${role}_${run}`, passwordHash],
            );
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`)
                .send({ username: `e2e_st651_${role}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${role}`).toBe(200);
            tokens[role] = login.body.accessToken as string;
        }

        const [{ vehicle_status_id: activeStatusId }] = await dataSource.query(
            `SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`,
        );
        const [{ vehicle_id: id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'van', 'ST-65.1 e2e', $2, 100, 10) RETURNING vehicle_id`,
            [activeStatusId, plate],
        );
        vehicleId = id;

        // Closed maintenance overlaps June 2–3 (2 Bolivia calendar days); open maintenance
        // overlaps June 4 through `to` (1 day). This vehicle has no deliveries in the period.
        await dataSource.query(
            `INSERT INTO vehicle_maintenances (vehicle_id, description, status, created_at, completed_at)
             VALUES ($1, $2, 'completed', $3::timestamptz, $4::timestamptz),
                    ($1, $5, 'in_progress', $6::timestamptz, NULL)`,
            [vehicleId, `${tag} closed`, '2026-06-02T16:00:00Z', '2026-06-03T16:00:00Z', `${tag} open`, '2026-06-04T16:00:00Z'],
        );
        await cache.delete(cacheKey);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await cache?.delete(cacheKey);
            await withEventPurge(dataSource, { userNames: usernames }, async (manager) => {
                await manager.query(`DELETE FROM vehicle_maintenances WHERE description LIKE $1`, [`${tag}%`]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = $1`, [vehicleId]);
                await manager.query(`DELETE FROM users WHERE username LIKE ANY($1::text[])`, [usernames]);
            });
        }
        await app?.close();
    });

    it('returns the inclusive period and aggregates maintenance-only vehicles', async () => {
        const response = await get('coordinator');

        expect(response.status).toBe(200);
        expect(response.body.from).toBe(from);
        expect(response.body.to).toBe(to);
        expect(response.body.drivers).toEqual([]);
        expect(response.body.vehicles).toContainEqual(expect.objectContaining({
            groupId: vehicleId,
            groupName: plate,
            closedCount: 0,
            deliveredCount: 0,
            incidentCount: 0,
            maintenanceCount: 2,
            daysInMaintenance: 3,
        }));
    });

    it('rejects invalid and reversed date ranges with HTTP 400', async () => {
        expect((await get('coordinator', { from: '2026-06-31', to })).status).toBe(400);
        const reversed = await get('coordinator', { from: '2026-06-05', to: '2026-06-04' });
        expect(reversed.status).toBe(400);
        expect(reversed.body.error).toBe('INVALID_DATE_RANGE');
    });

    it('allows coordinator and supervisor, while denying driver and anonymous callers', async () => {
        expect((await get('coordinator')).status).toBe(200);
        expect((await get('supervisor')).status).toBe(200);
        expect((await get('driver')).status).toBe(403);
        expect((await get(null)).status).toBe(401);
    });

    it('caches the complete response for ten minutes', async () => {
        await cache.delete(cacheKey);
        const setWithTtl = vi.spyOn(cache, 'setWithTtl');
        const first = await get('coordinator');
        expect(first.status).toBe(200);
        expect(setWithTtl).toHaveBeenCalledWith(cacheKey, expect.any(String), 600);
        // Change persisted data after the first request. A hit must keep returning the cached snapshot.
        await dataSource.query(
            `INSERT INTO vehicle_maintenances (vehicle_id, description, status, created_at, completed_at)
             VALUES ($1, $2, 'completed', $3::timestamptz, $4::timestamptz)`,
            [vehicleId, `${tag} after cache`, '2026-06-04T16:00:00Z', '2026-06-04T16:00:00Z'],
        );
        const second = await get('coordinator');
        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        vi.restoreAllMocks();
    });
});
