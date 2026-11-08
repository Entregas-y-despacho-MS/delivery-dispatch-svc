// ST-61.1 — Real HTTP/PostgreSQL acceptance checks for GET /fleet/kpis (RF-A14).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { DriverMetricsPeriod, resolveMetricsRange } from '../src/app/driver-metrics/domain/metrics-period.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver';
type Who = 'A' | 'B';

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (day: string, days: number): string => new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

describe('GET /fleet/kpis (e2e, ST-61.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let cache: CacheService;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST611-${run}`;
    const names = { driverA: `E2E611 Ana ${run}`, driverB: `E2E611 Beto ${run}`, plateA: `E611A${run}`.slice(0, 15), plateB: `E611B${run}`.slice(0, 15) };
    const ids = { driver: {} as Record<Who, number>, vehicle: {} as Record<Who, number>, batch: {} as Record<Who, number> };
    const statusIds: Record<string, number> = {};
    let deliveryTypeId = 0;
    let sequence = 0;

    // The periods are relative to today, so the dispatches are too: one today, one on the first day of the week, one on the first
    // day of the month and one the day before the month (never counted). Each period then holds the ones whose day it covers.
    const today = resolveMetricsRange(DriverMetricsPeriod.TODAY).to;
    const weekFrom = resolveMetricsRange(DriverMetricsPeriod.WEEK).from;
    const monthFrom = resolveMetricsRange(DriverMetricsPeriod.MONTH).from;
    const seeds: { n: number; day: string; who: Who; incidents?: number }[] = [
        { n: 1, day: today, who: 'A', incidents: 1 },
        { n: 2, day: weekFrom, who: 'A' },
        { n: 3, day: monthFrom, who: 'B' },
        { n: 4, day: addDays(monthFrom, -1), who: 'B' },
    ];

    /** How many seeded dispatches the period covers, per driver (= per vehicle: A has vehicle A, B has vehicle B). */
    const expected = (period: DriverMetricsPeriod, who: Who): { delivered: number; incidents: number } => {
        const { from, to } = resolveMetricsRange(period);
        const inside = seeds.filter((s) => s.who === who && s.day >= from && s.day <= to);
        return { delivered: inside.length, incidents: inside.reduce((sum, s) => sum + (s.incidents ?? 0), 0) };
    };

    const get = (actor: Actor | null, query: Record<string, string | undefined>) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/fleet/kpis`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const kpis = (period: string) => get('coordinator', { period });
    const row = (rows: { groupName: string | null }[], name: string) => rows.find((r) => r.groupName === name);
    const cacheKey = (groupBy: string, period: DriverMetricsPeriod) => {
        const { from, to } = resolveMetricsRange(period);
        return `reports:sla:${groupBy}:${from}:${to}`;
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);
        cache = app.get(CacheService, { strict: false });

        const passwordHash = await hashPassword('E2eTest1234');
        const createUser = async (roleName: string, fullName: string, username: string): Promise<number> => {
            const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [roleName]);
            const [{ user_id: userId }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [roleId, fullName, username, passwordHash],
            );
            return userId;
        };
        for (const actor of ['coordinator', 'supervisor', 'driver'] as const) {
            await createUser(actor, `ST-61.1 ${actor} ${run}`, `e2e_st611_${actor}_${run}`);
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st611_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }

        ids.driver.A = await createUser('driver', names.driverA, `e2e_st611_ana_${run}`);
        ids.driver.B = await createUser('driver', names.driverB, `e2e_st611_beto_${run}`);
        const [{ vehicle_status_id: activeStatusId }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
        for (const [who, plate] of [['A', names.plateA], ['B', names.plateB]] as const) {
            const [{ vehicle_id: vehicleId }] = await dataSource.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ($1, 'van', 'Hiace e2e', $2, 100, 10) RETURNING vehicle_id`,
                [activeStatusId, plate],
            );
            ids.vehicle[who] = vehicleId;
            const [{ route_batch_id: batchId }] = await dataSource.query(
                `INSERT INTO route_batches (status, shift_date, driver_id, vehicle_id, version) VALUES ('closed', $1, $2, $3, 0) RETURNING route_batch_id`,
                [today, ids.driver[who], vehicleId],
            );
            ids.batch[who] = batchId;
        }
        const [{ incident_reason_id: reasonId }] = await dataSource.query(
            `INSERT INTO incident_reasons (code, name) VALUES ($1, $2) RETURNING incident_reason_id`, [`E611-${run}`, `E2E611 reason ${run}`]);
        for (const r of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[r.name] = r.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        for (const seed of seeds) {
            sequence += 1;
            // Noon in Bolivia (16:00Z), inside a window of one hour around it: delivered on time.
            const [{ dispatch_id: dispatchId }] = await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, tracking_code, delivery_address, evidence_policy,
                                         closed_at, scheduled_window_start, scheduled_window_end)
                 VALUES ($1, $2, $3, $4, $5, 'Dirección E2E ST-61.1', 'hand_delivery_standard', $6::timestamptz, $6::timestamptz - interval '1 hour', $6::timestamptz + interval '1 hour')
                 RETURNING dispatch_id`,
                [deliveryTypeId, statusIds.delivered, ids.batch[seed.who], `${prefix}-${seed.n}`, `DSP-2031-${String(80000 + sequence)}`, `${seed.day}T16:00:00Z`],
            );
            for (let i = 0; i < (seed.incidents ?? 0); i += 1) {
                await dataSource.query(
                    `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id) VALUES (gen_random_uuid(), $1, $2)`, [dispatchId, reasonId]);
            }
        }
    });

    afterEach(() => { vi.restoreAllMocks(); });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: Object.values(ids.batch), userNames: [`e2e_st611_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [Object.values(ids.batch)]);
                await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [Object.values(ids.vehicle)]);
                await manager.query(`DELETE FROM incident_reasons WHERE code = $1`, [`E611-${run}`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st611_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe.each([DriverMetricsPeriod.TODAY, DriverMetricsPeriod.WEEK, DriverMetricsPeriod.MONTH])('period %s', (period) => {
        it('answers the days of the period, the drivers and the vehicles (by plate) with their closed dispatches and incidents', async () => {
            const response = await kpis(period);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ period, ...resolveMetricsRange(period) });
            for (const who of ['A', 'B'] as const) {
                const { delivered, incidents } = expected(period, who);
                const driver = row(response.body.drivers, who === 'A' ? names.driverA : names.driverB);
                const vehicle = row(response.body.vehicles, who === 'A' ? names.plateA : names.plateB);
                if (delivered === 0) {
                    expect(driver).toBeUndefined();
                    expect(vehicle).toBeUndefined();
                    continue;
                }
                expect(driver).toMatchObject({ groupId: ids.driver[who], closedCount: delivered, deliveredCount: delivered, onTimeCount: delivered, onTimePercentage: 100, incidentCount: incidents });
                expect(vehicle).toMatchObject({ groupId: ids.vehicle[who], closedCount: delivered, deliveredCount: delivered, onTimeCount: delivered, onTimePercentage: 100, incidentCount: incidents });
            }
            // The totals are the real sums of the drivers.
            const sum = (key: 'closedCount' | 'incidentCount') => response.body.drivers.reduce((total: number, d: Record<string, number>) => total + d[key], 0);
            expect(response.body.totals.closedCount).toBe(sum('closedCount'));
            expect(response.body.totals.incidentCount).toBe(sum('incidentCount'));
        });
    });

    it('does not count the dispatch of the day before the month in the month', async () => {
        const month = await kpis('month');
        const beto = row(month.body.drivers, names.driverB);
        expect(beto?.deliveredCount ?? 0).toBe(seeds.filter((s) => s.who === 'B' && s.day >= monthFrom).length);
    });

    describe('invalid requests and permissions', () => {
        it.each([{}, { period: 'year' }, { period: '' }])('rejects %j with 400', async (query) => {
            const response = await get('coordinator', query);

            expect(response.status).toBe(400);
            expect(JSON.stringify(response.body.message)).toContain("The 'period' parameter must be one of: today, week, month.");
        });

        it('the coordinator and the supervisor read it (200)', async () => {
            expect((await get('coordinator', { period: 'week' })).status).toBe(200);
            expect((await get('supervisor', { period: 'week' })).status).toBe(200);
        });

        it('the driver gets 403 and a call without token 401', async () => {
            expect((await get('driver', { period: 'week' })).status).toBe(403);
            expect((await get(null, { period: 'week' })).status).toBe(401);
        });
    });

    describe('cache', () => {
        const aggregations = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('WITH closed AS')).length;

        it('stores each grouping for 10 minutes under the key of the SLA report and serves the second call from it', async () => {
            const period = DriverMetricsPeriod.MONTH;
            await cache.delete(cacheKey('driver', period));
            await cache.delete(cacheKey('vehicle', period));
            const setWithTtl = vi.spyOn(cache, 'setWithTtl');
            const query = vi.spyOn(dataSource, 'query');

            const first = await kpis(period);

            expect(first.status).toBe(200);
            expect(aggregations(query)).toBe(2);
            expect(setWithTtl).toHaveBeenCalledWith(cacheKey('driver', period), expect.any(String), 600);
            expect(setWithTtl).toHaveBeenCalledWith(cacheKey('vehicle', period), expect.any(String), 600);

            query.mockClear();
            const second = await kpis(period);

            expect(second.body).toEqual(first.body);
            expect(aggregations(query)).toBe(0);
        });

        it('shares the entry by driver with GET /reports/sla', async () => {
            const period = DriverMetricsPeriod.WEEK;
            const { from, to } = resolveMetricsRange(period);
            await cache.delete(cacheKey('driver', period));
            await cache.delete(cacheKey('vehicle', period));
            await request(app.getHttpServer()).get(`/${apiPrefix}/reports/sla`).query({ from, to, groupBy: 'driver' }).set('Authorization', `Bearer ${tokens.coordinator}`).expect(200);
            const query = vi.spyOn(dataSource, 'query');

            await kpis(period);

            // The driver entry was written by /reports/sla: only the vehicle grouping goes to PostgreSQL.
            expect(aggregations(query)).toBe(1);
        });

        it('answers from PostgreSQL when Redis does not answer, on the read and on the write', async () => {
            vi.spyOn(cache, 'get').mockRejectedValue(new Error('Redis down'));
            vi.spyOn(cache, 'setWithTtl').mockRejectedValue(new Error('Redis down'));

            const response = await kpis('today');

            expect(response.status).toBe(200);
            expect(row(response.body.drivers, names.driverA)).toMatchObject({ deliveredCount: expected(DriverMetricsPeriod.TODAY, 'A').delivered });
        });

        it('recomputes an entry that is not a valid report', async () => {
            const period = DriverMetricsPeriod.TODAY;
            await cache.setWithTtl(cacheKey('vehicle', period), 'garbage', 600);

            const response = await kpis(period);

            expect(response.status).toBe(200);
            expect(row(response.body.vehicles, names.plateA)).toMatchObject({ groupId: ids.vehicle.A });
            expect(JSON.parse((await cache.get(cacheKey('vehicle', period)))!).groupBy).toBe('vehicle');
        });
    });

    it('GET /reports/sla still rejects the vehicle grouping (it belongs to the KPIs)', async () => {
        const { from, to } = resolveMetricsRange(DriverMetricsPeriod.TODAY);
        const response = await request(app.getHttpServer()).get(`/${apiPrefix}/reports/sla`).query({ from, to, groupBy: 'vehicle' }).set('Authorization', `Bearer ${tokens.coordinator}`);

        expect(response.status).toBe(400);
    });
});
