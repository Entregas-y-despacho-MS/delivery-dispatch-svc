// ST-54.2 — Real HTTP/PostgreSQL acceptance checks for GET /reports/sla (RF-A07).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { CacheService } from '../src/plugins/cache/cache.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver';
type Zone = 'N' | 'S' | null;
type Level = 'A' | 'B' | null;
type Batch = 'A' | 'B' | null;

interface Seed {
    n: number;
    type?: 'delivery' | 'supplier_pickup';
    status: string;
    zone: Zone;
    level: Level;
    batch: Batch;
    closedAt: string;
    window?: [string, string] | null;
    incidents?: number;
    /** `departedAt` of the `out_for_delivery` event of the route start. */
    departedAt?: string;
}

// Everything lives in March, April and May of 2031: no other suite writes dispatches there, so the totals are exact.
// Bolivia is UTC-4: 14:00-16:00 there is 18:00Z-20:00Z, and 23:59 of the 31st is 03:59Z of the next day.
const WINDOW: [string, string] = ['2031-03-10T18:00:00Z', '2031-03-10T20:00:00Z'];
const EDGE_WINDOW: [string, string] = ['2031-04-01T02:00:00Z', '2031-04-01T05:00:00Z'];
const MARCH = { from: '2031-03-01', to: '2031-03-31' };

describe('GET /reports/sla (e2e, ST-54.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let cache: CacheService;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST542-${run}`;
    const names = { zoneN: `E2E542 ${run} Norte`, zoneS: `E2E542 ${run} Sur`, levelA: `E2E542 Gold ${run}`, levelB: `E2E542 Retired ${run}`, driverA: `E2E542 Ana ${run}`, driverB: `E2E542 Beto ${run}` };
    const ids = { zone: {} as Record<'N' | 'S', number>, level: {} as Record<'A' | 'B', number>, driver: {} as Record<'A' | 'B', number>, batch: {} as Record<'A' | 'B', number>, reason: 0 };
    const statusIds: Record<string, number> = {};
    const typeIds: Record<string, number> = {};
    let sequence = 0;

    const get = (actor: Actor | null, query: Record<string, string | undefined>) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/reports/sla`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const report = (groupBy: string, range: { from: string; to: string } = MARCH) => get('coordinator', { ...range, groupBy });
    const cacheKey = (groupBy: string, range: { from: string; to: string }) => `reports:sla:${groupBy}:${range.from}:${range.to}`;

    const insertDispatch = async (seed: Seed): Promise<number> => {
        sequence += 1;
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, service_level_id, route_batch_id, source_order_ref,
                                     tracking_code, delivery_address, evidence_policy, closed_at, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'Dirección E2E ST-54.2', 'hand_delivery_standard', $8, $9, $10) RETURNING dispatch_id`,
            [
                typeIds[seed.type ?? 'delivery'], statusIds[seed.status],
                seed.zone ? ids.zone[seed.zone] : null, seed.level ? ids.level[seed.level] : null, seed.batch ? ids.batch[seed.batch] : null,
                `${prefix}-${seed.n}`, `DSP-2031-${String(90000 + sequence)}`, seed.closedAt, seed.window?.[0] ?? null, seed.window?.[1] ?? null,
            ],
        );
        if (seed.departedAt) {
            await dataSource.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, metadata) VALUES ($1, 'status_changed', $2::jsonb)`,
                [id, JSON.stringify({ status: 'out_for_delivery', departedAt: seed.departedAt })],
            );
        }
        for (let i = 0; i < (seed.incidents ?? 0); i += 1) {
            await dataSource.query(
                `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id) VALUES (gen_random_uuid(), $1, $2)`,
                [id, ids.reason],
            );
        }
        return id;
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

        for (const [actor, role] of [['coordinator', 'coordinator'], ['supervisor', 'supervisor'], ['driver', 'driver']] as const) {
            await createUser(role, `ST-54.2 ${actor} ${run}`, `e2e_st542_${actor}_${run}`);
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st542_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }

        // The drivers of the routes; Beto was removed later (soft delete) and must still appear: he made the trips.
        ids.driver.A = await createUser('driver', names.driverA, `e2e_st542_ana_${run}`);
        ids.driver.B = await createUser('driver', names.driverB, `e2e_st542_beto_${run}`);
        await dataSource.query(`UPDATE users SET deleted_at = NOW() WHERE user_id = $1`, [ids.driver.B]);

        for (const [key, name] of [['N', names.zoneN], ['S', names.zoneS]] as const) {
            const [{ delivery_zone_id: id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z542${run}${key}`, name]);
            ids.zone[key] = id;
        }
        // Own levels, so the suite does not depend on the seeded Standard/Express: A is active, B was deactivated.
        for (const [key, name, priority, active] of [['A', names.levelA, 7, true], ['B', names.levelB, 8, false]] as const) {
            const [{ service_level_id: id }] = await dataSource.query(
                `INSERT INTO service_levels (name, target_time_min, priority_level, active) VALUES ($1, 240, $2, $3) RETURNING service_level_id`, [name, priority, active]);
            ids.level[key] = id;
        }
        [{ incident_reason_id: ids.reason }] = await dataSource.query(
            `INSERT INTO incident_reasons (code, name) VALUES ($1, $2) RETURNING incident_reason_id`, [`E542-${run}`, `E2E542 reason ${run}`]);
        for (const [key, driver] of [['A', 'A'], ['B', 'B']] as const) {
            const [{ route_batch_id: id }] = await dataSource.query(
                `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, '2031-03-10', 'closed') RETURNING route_batch_id`, [ids.driver[driver]]);
            ids.batch[key] = id;
        }
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        for (const row of await dataSource.query(`SELECT dispatch_type_id, name FROM dispatch_types`)) typeIds[row.name] = row.dispatch_type_id;

        // March: the cases of the report, by dispatch (see the expected figures in each test).
        await insertDispatch({ n: 1, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-03-10T19:00:00Z', window: WINDOW, departedAt: '2031-03-10T12:00:00.000Z', incidents: 1 }); // on time, cycle 420
        await insertDispatch({ n: 2, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-03-10T20:30:00Z', window: WINDOW, departedAt: '2031-03-10T12:00:00.000Z' });     // 30 min late, cycle 510
        await insertDispatch({ n: 3, status: 'delivered', zone: 'N', level: 'A', batch: 'B', closedAt: '2031-03-10T17:00:00Z', window: WINDOW });                                           // before the window: out of it, no delay
        await insertDispatch({ n: 4, status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-03-10T19:00:00Z', window: null });                                             // no window: never on time
        await insertDispatch({ n: 5, status: 'not_delivered', zone: 'S', level: null, batch: 'B', closedAt: '2031-03-12T19:00:00Z', window: WINDOW });
        await insertDispatch({ n: 6, status: 'returned', zone: 'S', level: 'A', batch: null, closedAt: '2031-03-12T19:00:00Z', incidents: 2 });                                              // no route, two incidents
        await insertDispatch({ n: 7, status: 'delivered', zone: null, level: 'B', batch: 'A', closedAt: '2031-03-10T19:00:00Z', window: WINDOW });                                           // no zone, level deactivated
        await insertDispatch({ n: 8, status: 'cancelled', zone: 'S', level: 'A', batch: null, closedAt: '2031-03-12T19:00:00Z' });                                                         // not counted: cancelled
        await insertDispatch({ n: 9, type: 'supplier_pickup', status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-03-10T19:00:00Z', window: WINDOW });                  // not counted: not a delivery
        await insertDispatch({ n: 10, status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-04-01T03:59:00Z', window: EDGE_WINDOW });                                    // 23:59 of March 31 in Bolivia: counted
        await insertDispatch({ n: 11, status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-04-01T04:01:00Z', window: EDGE_WINDOW });                                    // 00:01 of April 1: not in March
        await insertDispatch({ n: 12, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-03-01T03:59:00Z', window: ['2031-03-01T02:00:00Z', '2031-03-01T05:00:00Z'] }); // 23:59 of February 28: not in March
        // July: the ends of the window. Closed exactly at its start or at its end is on time; one second after the end is late.
        const julyWindow: [string, string] = ['2031-07-10T18:00:00Z', '2031-07-10T20:00:00Z'];
        await insertDispatch({ n: 30, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-07-10T18:00:00Z', window: julyWindow });
        await insertDispatch({ n: 31, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-07-10T20:00:00Z', window: julyWindow });
        await insertDispatch({ n: 32, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-07-10T20:00:01Z', window: julyWindow });
        // May: two dispatches, for the cache tests that only read. August: one, for the test that adds another one in the middle.
        await insertDispatch({ n: 20, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-05-10T19:00:00Z', window: ['2031-05-10T18:00:00Z', '2031-05-10T20:00:00Z'] });
        await insertDispatch({ n: 21, status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-05-11T19:00:00Z', window: ['2031-05-11T18:00:00Z', '2031-05-11T20:00:00Z'] });
        await insertDispatch({ n: 40, status: 'delivered', zone: 'N', level: 'A', batch: 'A', closedAt: '2031-08-10T19:00:00Z', window: ['2031-08-10T18:00:00Z', '2031-08-10T20:00:00Z'] });
    });

    afterEach(() => { vi.restoreAllMocks(); });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: Object.values(ids.batch), userNames: [`e2e_st542_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [Object.values(ids.batch)]);
                await manager.query(`DELETE FROM incident_reasons WHERE code = $1`, [`E542-${run}`]);
                await manager.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`E2E542 % ${run}`]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z542${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st542_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('groupings', () => {
        it('by zone: counts, percentages, delay, cycle and incidents per zone, the dispatches without zone last, and the totals from the real sums', async () => {
            const response = await report('zone');

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ ...MARCH, groupBy: 'zone' });
            expect(response.body.rows).toEqual([
                { groupId: ids.zone.N, groupName: names.zoneN, closedCount: 3, deliveredCount: 3, onTimeCount: 1, lateCount: 1, onTimePercentage: 33.3, averageDelayMinutes: 30, averageCycleMinutes: 465, incidentCount: 1 },
                { groupId: ids.zone.S, groupName: names.zoneS, closedCount: 4, deliveredCount: 2, onTimeCount: 1, lateCount: 0, onTimePercentage: 50, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 2 },
                { groupId: null, groupName: null, closedCount: 1, deliveredCount: 1, onTimeCount: 1, lateCount: 0, onTimePercentage: 100, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 0 },
            ]);
            expect(response.body.totals).toEqual({ closedCount: 8, deliveredCount: 6, onTimeCount: 3, lateCount: 1, onTimePercentage: 50, averageDelayMinutes: 30, averageCycleMinutes: 465, incidentCount: 3 });
        });

        it('by service level: only the active levels, the dispatches without level in their own row', async () => {
            const response = await report('service_level');

            expect(response.status).toBe(200);
            expect(response.body.groupBy).toBe('service_level');
            expect(response.body.rows).toEqual([
                { groupId: ids.level.A, groupName: names.levelA, closedCount: 6, deliveredCount: 5, onTimeCount: 2, lateCount: 1, onTimePercentage: 40, averageDelayMinutes: 30, averageCycleMinutes: 465, incidentCount: 3 },
                { groupId: null, groupName: null, closedCount: 1, deliveredCount: 0, onTimeCount: 0, lateCount: 0, onTimePercentage: 0, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 0 },
            ]);
            // The deactivated level (dispatch 7) is in neither the rows nor the totals.
            expect(response.body.rows.map((row: { groupName: string | null }) => row.groupName)).not.toContain(names.levelB);
            expect(response.body.totals).toMatchObject({ closedCount: 7, deliveredCount: 5, onTimeCount: 2, incidentCount: 3 });
        });

        it('by driver: the driver of the route (also the one removed later), the dispatches without route last', async () => {
            const response = await report('driver');

            expect(response.status).toBe(200);
            expect(response.body.rows).toEqual([
                { groupId: ids.driver.A, groupName: names.driverA, closedCount: 3, deliveredCount: 3, onTimeCount: 2, lateCount: 1, onTimePercentage: 66.7, averageDelayMinutes: 30, averageCycleMinutes: 465, incidentCount: 1 },
                { groupId: ids.driver.B, groupName: names.driverB, closedCount: 4, deliveredCount: 3, onTimeCount: 1, lateCount: 0, onTimePercentage: 33.3, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 0 },
                { groupId: null, groupName: null, closedCount: 1, deliveredCount: 0, onTimeCount: 0, lateCount: 0, onTimePercentage: 0, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 2 },
            ]);
            expect(response.body.totals).toEqual({ closedCount: 8, deliveredCount: 6, onTimeCount: 3, lateCount: 1, onTimePercentage: 50, averageDelayMinutes: 30, averageCycleMinutes: 465, incidentCount: 3 });
        });
    });

    describe('what is counted', () => {
        it('uses Bolivia days: 23:59 of the last day is in, 00:01 of the next day is out', async () => {
            const lastDay = await report('zone', { from: '2031-03-31', to: '2031-03-31' });
            expect(lastDay.body.totals).toMatchObject({ closedCount: 1, deliveredCount: 1, onTimeCount: 1 });

            const nextDay = await report('zone', { from: '2031-04-01', to: '2031-04-01' });
            expect(nextDay.body.totals).toMatchObject({ closedCount: 1, deliveredCount: 1, onTimeCount: 1 });

            const previousDay = await report('zone', { from: '2031-02-28', to: '2031-02-28' });
            expect(previousDay.body.totals).toMatchObject({ closedCount: 1, deliveredCount: 1 });
        });

        it('a single day only counts what closed that day', async () => {
            const response = await report('zone', { from: '2031-03-10', to: '2031-03-10' });

            // 1, 2, 3, 4 and 7 closed on the 10th (5, 6 and 8 on the 12th; 9 is not a delivery).
            expect(response.body.totals).toMatchObject({ closedCount: 5, deliveredCount: 5, onTimeCount: 2, lateCount: 1 });
        });

        it('the start and the end of the window are on time; one second after the end is late', async () => {
            const response = await report('zone', { from: '2031-07-01', to: '2031-07-31' });

            expect(response.body.totals).toMatchObject({ closedCount: 3, deliveredCount: 3, onTimeCount: 2, lateCount: 1, onTimePercentage: 66.7, averageDelayMinutes: 0 });
        });

        it('a range with nothing closed gives no rows and zero totals (200, not an error)', async () => {
            const response = await report('driver', { from: '2031-06-01', to: '2031-06-30' });

            expect(response.status).toBe(200);
            expect(response.body.rows).toEqual([]);
            expect(response.body.totals).toEqual({ closedCount: 0, deliveredCount: 0, onTimeCount: 0, lateCount: 0, onTimePercentage: 0, averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 0 });
        });
    });

    describe('invalid requests', () => {
        it('rejects a `from` after the `to` with INVALID_DATE_RANGE', async () => {
            const response = await report('zone', { from: '2031-03-31', to: '2031-03-01' });
            expect(response.status).toBe(400);
            expect(response.body.error).toBe('INVALID_DATE_RANGE');
        });

        it('rejects a range of more than 366 days with DATE_RANGE_TOO_LARGE, and accepts exactly 366', async () => {
            const tooLarge = await report('zone', { from: '2031-01-01', to: '2032-01-02' });
            expect(tooLarge.status).toBe(400);
            expect(tooLarge.body.error).toBe('DATE_RANGE_TOO_LARGE');

            const limit = await report('zone', { from: '2031-01-01', to: '2032-01-01' });
            expect(limit.status).toBe(200);
        });

        it.each([
            ['a missing `from`', { to: '2031-03-31', groupBy: 'zone' }, "The 'from' parameter must be a valid date in YYYY-MM-DD format."],
            ['a missing `to`', { from: '2031-03-01', groupBy: 'zone' }, "The 'to' parameter must be a valid date in YYYY-MM-DD format."],
            ['a missing `groupBy`', { from: '2031-03-01', to: '2031-03-31' }, "The 'groupBy' parameter must be one of: zone, service_level, zone_service, driver."],
            ['a `groupBy` outside the list', { from: '2031-03-01', to: '2031-03-31', groupBy: 'vehicle' }, "The 'groupBy' parameter must be one of: zone, service_level, zone_service, driver."],
            ['a date that is not YYYY-MM-DD', { from: '01/03/2031', to: '2031-03-31', groupBy: 'zone' }, "The 'from' parameter must be a valid date in YYYY-MM-DD format."],
            ['a date that does not exist', { from: '2031-03-01', to: '2031-02-30', groupBy: 'zone' }, "The 'to' parameter must be a valid date in YYYY-MM-DD format."],
        ])('rejects %s with 400', async (_name, query, message) => {
            const response = await get('coordinator', query);
            expect(response.status).toBe(400);
            expect(response.body.message).toContain(message);
        });
    });

    describe('roles', () => {
        it('401 without a token', async () => {
            expect((await get(null, { ...MARCH, groupBy: 'zone' })).status).toBe(401);
        });

        it('403 for the supervisor and for the driver, 200 for the coordinator', async () => {
            expect((await get('supervisor', { ...MARCH, groupBy: 'zone' })).status).toBe(403);
            expect((await get('driver', { ...MARCH, groupBy: 'zone' })).status).toBe(403);
            expect((await get('coordinator', { ...MARCH, groupBy: 'zone' })).status).toBe(200);
        });
    });

    describe('cache', () => {
        // The tests below read May (two dispatches); only the first one writes, and it does it on August, so none depends on the others.
        const MAY = { from: '2031-05-01', to: '2031-05-31' };
        const AUG = { from: '2031-08-01', to: '2031-08-31' };

        it('stores the answer for 10 minutes under a key made of the parameters, and serves the second call from it', async () => {
            const setWithTtl = vi.spyOn(cache, 'setWithTtl');
            await cache.delete(cacheKey('zone', AUG));

            const first = await report('zone', AUG);
            expect(first.status).toBe(200);
            expect(first.body.totals.closedCount).toBe(1);
            expect(setWithTtl).toHaveBeenCalledWith(cacheKey('zone', AUG), expect.any(String), 600);
            expect(JSON.parse((await cache.get(cacheKey('zone', AUG)))!)).toEqual(first.body);

            // A new delivery of August. The entry is still there, so the second call does not see it.
            await insertDispatch({ n: 41, status: 'delivered', zone: 'S', level: 'A', batch: 'B', closedAt: '2031-08-11T19:00:00Z', window: ['2031-08-11T18:00:00Z', '2031-08-11T20:00:00Z'] });
            const second = await report('zone', AUG);
            expect(second.body).toEqual(first.body);

            // Once the entry is gone (here by hand, in production by expiring), the report is computed again.
            await cache.delete(cacheKey('zone', AUG));
            const third = await report('zone', AUG);
            expect(third.body.totals.closedCount).toBe(2);
        });

        it('keeps a separate entry per grouping: asking by driver does not return the entry by zone', async () => {
            await cache.delete(cacheKey('zone', MAY));
            await cache.delete(cacheKey('driver', MAY));
            const byZone = await report('zone', MAY);
            const byDriver = await report('driver', MAY);

            expect(byDriver.body.groupBy).toBe('driver');
            expect(byDriver.body.rows.map((row: { groupName: string | null }) => row.groupName)).not.toEqual(byZone.body.rows.map((row: { groupName: string | null }) => row.groupName));
        });

        it('recomputes and overwrites an entry that is not a valid report', async () => {
            await cache.setWithTtl(cacheKey('zone', MAY), 'garbage', 600);

            const response = await report('zone', MAY);

            expect(response.status).toBe(200);
            expect(response.body.totals.closedCount).toBe(2);
            expect(JSON.parse((await cache.get(cacheKey('zone', MAY)))!)).toEqual(response.body);
        });

        it('answers from PostgreSQL when Redis does not answer, on the read and on the write', async () => {
            await cache.delete(cacheKey('service_level', MAY));
            vi.spyOn(cache, 'get').mockRejectedValue(new Error('Redis down'));
            vi.spyOn(cache, 'setWithTtl').mockRejectedValue(new Error('Redis down'));

            const response = await report('service_level', MAY);

            expect(response.status).toBe(200);
            expect(response.body.totals.closedCount).toBe(2);
            expect(response.body.rows[0].groupName).toBe(names.levelA);
        });

        it('an invalid range never reaches the cache', async () => {
            const get = vi.spyOn(cache, 'get');

            const response = await report('zone', { from: '2031-05-31', to: '2031-05-01' });

            expect(response.status).toBe(400);
            // The settings snapshot also lives in the cache, so only the keys of the report count.
            expect(get.mock.calls.filter(([key]) => String(key).startsWith('reports:sla:'))).toEqual([]);
        });
    });
});
