// ST-301.1 — Real HTTP/PostgreSQL acceptance checks for GET /reports/otd and GET /reports/otd/backlog (ES-301).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { todayInOperatingTimeZone } from '../src/modules/dispatch/dispatches/utils/operating-date.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

type Actor = 'coordinator' | 'supervisor' | 'driver';

interface Seed {
    n: number;
    status: string;
    zone: 'MAR' | 'LIVE' | 'OTHER';
    level?: 'L1' | 'L2';
    /** [start, end] of the committed window; null = no window. */
    window: [string, string] | null;
    closedAt?: string;
    batch?: 'in_execution';
}

// March 2020: the past, so every promise has expired and no other suite writes there. Bolivia is UTC-4: 14:00-16:00 there is 18:00Z-20:00Z.
const win = (day: string): [string, string] => [`2020-03-${day}T18:00:00Z`, `2020-03-${day}T20:00:00Z`];
const MARCH = { from: '2020-03-01', to: '2020-03-31' };
const HOUR = 3_600_000;

describe('GET /reports/otd and /reports/otd/backlog (e2e, ST-301.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<Actor, string> = { coordinator: '', supervisor: '', driver: '' };
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3011-${run}`;
    const ids = { zone: {} as Record<'MAR' | 'LIVE' | 'OTHER', number>, level: {} as Record<'L1' | 'L2', number>, batch: 0, driver: 0, dispatch: {} as Record<number, number> };
    const statusIds: Record<string, number> = {};
    let deliveryTypeId = 0;

    const get = (actor: Actor | null, path: string, query: Record<string, string | number | undefined>) => {
        const req = request(app.getHttpServer()).get(`/${apiPrefix}/reports/otd${path}`).query(query);
        return actor ? req.set('Authorization', `Bearer ${tokens[actor]}`) : req;
    };
    const otd = (query: Record<string, string | number | undefined>) => get('coordinator', '', query);
    const backlog = (query: Record<string, string | number | undefined>) => get('coordinator', '/backlog', query);

    const insertDispatch = async (seed: Seed): Promise<number> => {
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, service_level_id, route_batch_id, source_order_ref,
                                     delivery_address, closed_at, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección E2E ST-301.1', $7, $8, $9) RETURNING dispatch_id`,
            [
                deliveryTypeId, statusIds[seed.status], ids.zone[seed.zone], seed.level ? ids.level[seed.level] : null, seed.batch ? ids.batch : null,
                `${prefix}-${seed.n}`, seed.closedAt ?? null, seed.window?.[0] ?? null, seed.window?.[1] ?? null,
            ],
        );
        ids.dispatch[seed.n] = id;
        return id;
    };

    const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const bolivianDay = (offsetDays: number) => new Date(Date.parse(`${todayInOperatingTimeZone()}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

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
            await createUser(actor, `ST-301.1 ${actor} ${run}`, `e2e_st3011_${actor}_${run}`);
            const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st3011_${actor}_${run}`, password: 'E2eTest1234' });
            expect(login.status, `login ${actor}`).toBe(200);
            tokens[actor] = login.body.accessToken as string;
        }
        ids.driver = await createUser('driver', `ST-301.1 route driver ${run}`, `e2e_st3011_route_${run}`);

        for (const key of ['MAR', 'LIVE', 'OTHER'] as const) {
            const [{ delivery_zone_id: id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z3011${run}${key}`, `E2E3011 ${run} ${key}`]);
            ids.zone[key] = id;
        }
        for (const [key, priority] of [['L1', 7], ['L2', 8]] as const) {
            const [{ service_level_id: id }] = await dataSource.query(
                `INSERT INTO service_levels (name, target_time_min, priority_level, active) VALUES ($1, 240, $2, true) RETURNING service_level_id`, [`E2E3011 ${key} ${run}`, priority]);
            ids.level[key] = id;
        }
        [{ route_batch_id: ids.batch }] = await dataSource.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, CURRENT_DATE, 'in_execution') RETURNING route_batch_id`, [ids.driver]);
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        const [{ reschedule_reason_id: reasonId }] = await dataSource.query(`SELECT reschedule_reason_id FROM reschedule_reasons ORDER BY reschedule_reason_id LIMIT 1`);

        // ── March 2020, zone MAR: every case of the OTD, by dispatch (see the expected figures in each test) ──
        await insertDispatch({ n: 1, status: 'delivered', zone: 'MAR', level: 'L1', window: win('10'), closedAt: '2020-03-10T19:00:00Z' });      // on time
        await insertDispatch({ n: 2, status: 'delivered', zone: 'MAR', level: 'L2', window: win('10'), closedAt: '2020-03-10T21:00:00Z' });      // late
        await insertDispatch({ n: 3, status: 'assigned', zone: 'MAR', level: 'L1', window: win('11') });                                          // open and overdue
        await insertDispatch({ n: 4, status: 'not_delivered', zone: 'MAR', level: 'L1', window: win('12'), closedAt: '2020-03-12T19:00:00Z' });  // failed
        await insertDispatch({ n: 5, status: 'returned', zone: 'MAR', level: 'L1', window: win('12'), closedAt: '2020-03-12T21:00:00Z' });       // returned
        await insertDispatch({ n: 6, status: 'cancelled', zone: 'MAR', level: 'L1', window: win('13'), closedAt: '2020-03-13T15:00:00Z' });      // cancelled before the promise expired: excluded
        await insertDispatch({ n: 7, status: 'cancelled', zone: 'MAR', level: 'L1', window: win('14'), closedAt: '2020-03-15T15:00:00Z' });      // cancelled after: not on time
        await insertDispatch({ n: 8, status: 'cancelled', zone: 'MAR', level: 'L1', window: null, closedAt: '2020-03-16T15:00:00Z' });           // cancelled, no window: cannot be told
        await insertDispatch({ n: 9, status: 'delivered', zone: 'MAR', level: 'L1', window: null, closedAt: '2020-03-17T19:00:00Z' });           // delivered without window: invalid
        await insertDispatch({ n: 10, status: 'assigned', zone: 'MAR', level: 'L1', window: ['2020-03-18T20:00:00Z', '2020-03-18T18:00:00Z'] });  // window ends before it starts: invalid
        await insertDispatch({ n: 11, status: 'delivered', zone: 'MAR', level: 'L1', window: win('19'), closedAt: '2020-03-19T19:00:00Z' });     // rescheduled, delivered inside the new window
        await insertDispatch({ n: 12, status: 'cancelled', zone: 'MAR', level: 'L1', window: win('25'), closedAt: '2020-03-07T15:00:00Z' });     // cancelled before its reschedule: the promise then was March 8
        await insertDispatch({ n: 13, status: 'delivered', zone: 'OTHER', level: 'L1', window: win('10'), closedAt: '2020-03-10T19:00:00Z' });   // another zone
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, metadata, created_at) VALUES ($1, 'status_changed', '{"status":"assigned"}'::jsonb, '2020-03-11T12:00:00Z')`,
            [ids.dispatch[3]]);
        for (const [n, previous, next, createdAt] of [
            [11, win('05'), win('19'), '2020-03-04T10:00:00Z'],
            [12, win('08'), win('25'), '2020-03-09T10:00:00Z'],
        ] as const) {
            await dataSource.query(
                `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, previous_window_start, previous_window_end, new_window_start, new_window_end, created_at)
                 VALUES ($1, $2, 'coordinator', $3, $4, $5, $6, $7)`,
                [ids.dispatch[n], reasonId, previous[0], previous[1], next[0], next[1], createdAt]);
        }

        // ── Around today, zone LIVE: what is open now. Windows are relative to the moment the suite runs ──
        await insertDispatch({ n: 20, status: 'assigned', zone: 'LIVE', window: [iso(-50 * HOUR), iso(-48 * HOUR)] });                    // open, overdue 2 days
        await insertDispatch({ n: 21, status: 'out_for_delivery', zone: 'LIVE', window: [iso(-75 * HOUR), iso(-72 * HOUR)] });            // open, overdue 3 days: the oldest
        await insertDispatch({ n: 22, status: 'scheduled', zone: 'LIVE', window: [iso(24 * HOUR), iso(26 * HOUR)] });                    // pending, promise not expired
        await insertDispatch({ n: 23, status: 'assigned', zone: 'LIVE', window: [iso(25 * HOUR), iso(27 * HOUR)] });                     // pending
        await insertDispatch({ n: 24, status: 'pending', zone: 'LIVE', window: null });                                                  // pending, not planned yet (no promise)
        await insertDispatch({ n: 25, status: 'rescheduled', zone: 'LIVE', window: [iso(24 * HOUR), iso(26 * HOUR)] });                  // waiting for a new window
        await insertDispatch({ n: 26, status: 'delivered', zone: 'LIVE', window: [iso(-50 * HOUR), iso(-48 * HOUR)], closedAt: iso(-49 * HOUR), batch: 'in_execution' }); // delivered inside a batch still running
        // 20 entered `assigned` five days ago. The planner writes the new status as `metadata.to` (the other writers use `metadata.status`):
        // both shapes must give the age of the stage. 21 has no event, so its age comes from its last update (just now).
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, metadata, created_at) VALUES ($1, 'status_changed', $2::jsonb, $3)`,
            [ids.dispatch[20], JSON.stringify({ from: 'scheduled', to: 'assigned' }), iso(-5 * 24 * HOUR)]);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: [ids.batch], userNames: [`e2e_st3011_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = $1`, [ids.batch]);
                await manager.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`E2E3011 % ${run}`]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z3011${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st3011_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('GET /reports/otd — OTD by cohort of expired promise', () => {
        it('counts the open, failed, returned and late ones in the denominator and shows every figure with the rate', async () => {
            const response = await otd({ ...MARCH, zoneId: ids.zone.MAR });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                ...MARCH,
                basis: 'promise',
                dateBasis: 'promise_window_end',
                timeZone: 'America/La_Paz',
                filters: { zoneId: ids.zone.MAR, serviceLevelId: null, status: null },
                firstAttempt: { available: expect.any(Boolean), coverage: { complete: expect.any(Boolean) } }, // measured in first-attempt.e2e-spec.ts
                empty: false,
            });
            // Eligible: 1 (on time), 2 (late), 3 (open), 4 (failed), 5 (returned), 7 (cancelled after the promise), 11 (on time, rescheduled).
            expect(response.body.metrics).toEqual({
                numerator: 2,
                denominator: 7,
                n: 7,
                percentage: 28.6,
                notOnTimeCount: 5,
                invalidWindowCount: 2, // 9 (delivered without window), 10 (window ends before it starts)
                excludedCancellations: { count: 2, reason: 'cancelled_before_promise_expired' }, // 6 and 12
                unreconstructableCancellationCount: 1, // 8
                rescheduledPromiseCount: 1, // 11
            });
        });

        it('measures a rescheduled dispatch against the window in force and a cancellation against the promise it had when it was cancelled', async () => {
            // 11 was promised for March 5 and moved to March 19: delivered on the 19th, it is on time. 12 was cancelled on the 7th,
            // before its move, so its promise was March 8: a cancellation before the promise, excluded.
            const response = await otd({ from: '2020-03-19', to: '2020-03-19', zoneId: ids.zone.MAR });
            expect(response.body.metrics).toMatchObject({ numerator: 1, denominator: 1, percentage: 100, excludedCancellations: { count: 0 } });

            const eighth = await otd({ from: '2020-03-08', to: '2020-03-08', zoneId: ids.zone.MAR });
            expect(eighth.body.metrics).toMatchObject({ denominator: 0, percentage: null, excludedCancellations: { count: 1 } });
            expect(eighth.body.empty).toBe(false);
        });

        it('does not count a promise that has not expired yet, nor a dispatch that has no promise', async () => {
            const response = await otd({ from: bolivianDay(-5), to: bolivianDay(3), zoneId: ids.zone.LIVE });

            // Eligible: 20 and 21 (open, overdue) and 26 (delivered inside its window). 22, 23 and 25 end in the future; 24 has no window.
            expect(response.body.metrics).toMatchObject({ numerator: 1, denominator: 3, invalidWindowCount: 0 });
        });

        it('filters by service level and by current status', async () => {
            const level = await otd({ ...MARCH, zoneId: ids.zone.MAR, serviceLevelId: ids.level.L2 });
            expect(level.body.metrics).toMatchObject({ numerator: 0, denominator: 1, percentage: 0 });
            expect(level.body.filters.serviceLevelId).toBe(ids.level.L2);

            const status = await otd({ ...MARCH, zoneId: ids.zone.MAR, status: 'assigned' });
            expect(status.body.metrics).toMatchObject({ numerator: 0, denominator: 1, invalidWindowCount: 1 });

            const other = await otd({ ...MARCH, zoneId: ids.zone.OTHER });
            expect(other.body.metrics).toMatchObject({ numerator: 1, denominator: 1 });
        });

        it('says «Sin datos» (no rate, empty) for an interval with nothing, not 0 and not an error', async () => {
            const response = await otd({ from: '2020-06-01', to: '2020-06-30', zoneId: ids.zone.MAR });

            expect(response.status).toBe(200);
            expect(response.body.empty).toBe(true);
            expect(response.body.metrics).toMatchObject({ numerator: 0, denominator: 0, n: 0, percentage: null });
        });

        it('uses Bolivia days: a promise ending at 23:30 of a Bolivia day is in that day, and not in the next one', async () => {
            await insertDispatch({ n: 30, status: 'assigned', zone: 'OTHER', window: ['2020-05-11T01:00:00Z', '2020-05-11T03:30:00Z'] }); // May 10, 23:30 in Bolivia
            const inDay = await otd({ from: '2020-05-10', to: '2020-05-10', zoneId: ids.zone.OTHER });
            const nextDay = await otd({ from: '2020-05-11', to: '2020-05-11', zoneId: ids.zone.OTHER });

            expect(inDay.body.metrics.denominator).toBe(1);
            expect(nextDay.body.metrics.denominator).toBe(0);
        });
    });

    describe('GET /reports/otd?basis=deliveredAt — historic punctuality of completed deliveries', () => {
        it('is a different rate with its own denominator, labelled as such, and the OTD by cohort is not changed by it', async () => {
            const historic = await otd({ ...MARCH, zoneId: ids.zone.MAR, basis: 'deliveredAt' });
            const cohort = await otd({ ...MARCH, zoneId: ids.zone.MAR });

            expect(historic.status).toBe(200);
            expect(historic.body).toMatchObject({ basis: 'deliveredAt', dateBasis: 'closed_at' });
            // Delivered and closed in March with a valid window: 1 (on time), 2 (late), 11 (on time). 9 has no window: apart.
            expect(historic.body.metrics).toEqual({
                numerator: 2,
                denominator: 3,
                n: 3,
                percentage: 66.7,
                notOnTimeCount: 1,
                invalidWindowCount: 1,
                excludedCancellations: { count: 4, reason: 'cancelled_not_a_completed_delivery' }, // 6, 7, 8 and 12
                unreconstructableCancellationCount: 0,
                rescheduledPromiseCount: 1,
            });
            expect(cohort.body.metrics.percentage).toBe(28.6);
            expect(cohort.body.basis).toBe('promise');
        });

        it('matches the closing time, not the promise: a delivery made in March of a promise of another month counts in March', async () => {
            const day = await otd({ from: '2020-03-17', to: '2020-03-17', zoneId: ids.zone.MAR, basis: 'deliveredAt' });
            expect(day.body.metrics).toMatchObject({ denominator: 0, invalidWindowCount: 1 });
        });
    });

    describe('GET /reports/otd/backlog — volume by dispatch', () => {
        it('counts each dispatch once, in separate buckets, and does not add the terminal ones to the backlog', async () => {
            const response = await backlog({ ...MARCH, zoneId: ids.zone.MAR });

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ ...MARCH, dateBasis: 'promise_window_end', timeZone: 'America/La_Paz', empty: false });
            // 1, 2, 9, 11 delivered · 3 open overdue · 10 pending (invalid window is never overdue) · 4 failed · 5 returned · 6, 7, 8, 12 cancelled.
            expect(response.body.counts).toEqual({ delivered: 4, openOverdue: 1, pending: 1, notDelivered: 1, rescheduled: 0, cancelled: 4, returned: 1 });
            expect(response.body.backlogTotal).toBe(2);
            expect(response.body.pendingByStage).toEqual([{ stage: 'assigned', total: 1, byAge: { under_1d: 1, '1d_to_3d': 0, over_3d: 0 } }]);
            // 3 entered `assigned` on March 11: more than three days ago.
            expect(response.body.openOverdueByAge).toEqual({ under_1d: 0, '1d_to_3d': 0, over_3d: 1 });
        });

        it('lists the open overdue ones, the most overdue first, with their next action', async () => {
            const response = await backlog({ from: bolivianDay(-5), to: bolivianDay(3), zoneId: ids.zone.LIVE });

            expect(response.body.openOverdue.map((row: { dispatchId: number }) => row.dispatchId)).toEqual([ids.dispatch[21], ids.dispatch[20]]);
            expect(response.body.openOverdue[0]).toMatchObject({ status: 'out_for_delivery', nextAction: 'follow_delivery', zoneId: ids.zone.LIVE, trackingCode: null });
            expect(response.body.openOverdue[0].overdueMinutes).toBeGreaterThanOrEqual(72 * 60);
            expect(response.body.openOverdue[1]).toMatchObject({ status: 'assigned', nextAction: 'start_route' });
        });

        it('splits what is open now by exclusive stage and counts a delivery inside a batch still running as delivered', async () => {
            const response = await backlog({ from: bolivianDay(-5), to: bolivianDay(3), zoneId: ids.zone.LIVE });

            expect(response.body.counts).toEqual({ delivered: 1, openOverdue: 2, pending: 3, notDelivered: 0, rescheduled: 1, cancelled: 0, returned: 0 });
            expect(response.body.backlogTotal).toBe(5);
            expect(response.body.pendingByStage.map((stage: { stage: string }) => stage.stage)).toEqual(['pending', 'scheduled', 'assigned']);
            for (const stage of response.body.pendingByStage) expect(stage.total).toBe(1);
            // Overdue: 20 (five days in `assigned`, event written as `to`) and 21 (no event: its last update, just now).
            expect(response.body.openOverdueByAge).toEqual({ under_1d: 1, '1d_to_3d': 0, over_3d: 1 });
        });

        it('caps the list with `overdueLimit` without changing the counts', async () => {
            const response = await backlog({ from: bolivianDay(-5), to: bolivianDay(3), zoneId: ids.zone.LIVE, overdueLimit: 1 });

            expect(response.body.openOverdue).toHaveLength(1);
            expect(response.body.openOverdue[0].dispatchId).toBe(ids.dispatch[21]);
            expect(response.body.counts.openOverdue).toBe(2);
        });

        it('applies the filters to every figure, and says «Sin datos» when nothing matches', async () => {
            const status = await backlog({ from: bolivianDay(-5), to: bolivianDay(3), zoneId: ids.zone.LIVE, status: 'assigned' });
            expect(status.body.counts).toMatchObject({ openOverdue: 1, pending: 1, delivered: 0, rescheduled: 0 });

            const empty = await backlog({ from: '2020-06-01', to: '2020-06-30', zoneId: ids.zone.MAR });
            expect(empty.status).toBe(200);
            expect(empty.body.empty).toBe(true);
            expect(empty.body.counts).toEqual({ delivered: 0, openOverdue: 0, pending: 0, notDelivered: 0, rescheduled: 0, cancelled: 0, returned: 0 });
            expect(empty.body.openOverdue).toEqual([]);
        });
    });

    describe('invalid requests and roles', () => {
        it.each(['', '/backlog'])('rejects a `from` after the `to` and a range of more than 366 days (%s)', async (path) => {
            const inverted = await get('coordinator', path, { from: '2020-03-31', to: '2020-03-01' });
            expect(inverted.status).toBe(400);
            expect(inverted.body.error).toBe('INVALID_DATE_RANGE');

            const tooLarge = await get('coordinator', path, { from: '2020-01-01', to: '2021-01-02' });
            expect(tooLarge.status).toBe(400);
            expect(tooLarge.body.error).toBe('DATE_RANGE_TOO_LARGE');
        });

        it.each([
            ['', 'a missing `from`', { to: '2020-03-31' }, "The 'from' parameter must be a valid date in YYYY-MM-DD format."],
            ['', 'a basis outside the list', { ...MARCH, basis: 'closed' }, "The 'basis' parameter must be one of: promise, deliveredAt."],
            ['', 'a status that does not exist', { ...MARCH, status: 'lost' }, "The 'status' parameter must be one of:"],
            ['', 'a zone that is not a number', { ...MARCH, zoneId: 'abc' }, "The 'zoneId' parameter must be an integer."],
            ['', 'a zone bigger than a Postgres integer', { ...MARCH, zoneId: 2147483648 }, "The 'zoneId' parameter must be <= 2147483647."],
            ['/backlog', 'a list size above 100', { ...MARCH, overdueLimit: 101 }, "The 'overdueLimit' parameter must be <= 100."],
            ['/backlog', 'a list size of 0', { ...MARCH, overdueLimit: 0 }, "The 'overdueLimit' parameter must be >= 1."],
            ['/backlog', 'an unknown parameter', { ...MARCH, limit: 5 }, 'property limit should not exist'],
        ])('%s rejects %s with 400', async (path, _name, query, message) => {
            const response = await get('coordinator', path, query as Record<string, string | number>);
            expect(response.status).toBe(400);
            expect(JSON.stringify(response.body.message)).toContain(message);
        });

        it.each(['', '/backlog'])('401 without a token, 403 for the supervisor and the driver, 200 for the coordinator (%s)', async (path) => {
            expect((await get(null, path, MARCH)).status).toBe(401);
            expect((await get('supervisor', path, MARCH)).status).toBe(403);
            expect((await get('driver', path, MARCH)).status).toBe(403);
            expect((await get('coordinator', path, MARCH)).status).toBe(200);
        });
    });
});
