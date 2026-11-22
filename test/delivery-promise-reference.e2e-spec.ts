// ST-301.4 — volumes and formulas of Dashboard 1 (GET /reports/otd, GET /reports/otd/backlog) against a reference table.
// Every case below is one delivery dispatch whose expected classification was worked out by hand, in three columns: how it
// counts in the OTD by promise, in the punctuality by completed delivery (`basis=deliveredAt`) and which bucket of the
// backlog it falls in. The expected figures are derived from the table, without a filter and with each filter, and the API
// must return exactly them. Complements the case-by-case checks of ST-301.1 (delivery-promise.e2e-spec.ts).
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

type Zone = 'Z1' | 'Z2';
type Level = 'L1' | 'L2';
/** How a dispatch counts in an OTD rate: in the denominator (on time or not), apart, or not at all. */
type OtdClass = 'on_time' | 'not_on_time' | 'invalid_window' | 'excluded_cancellation' | 'unreconstructable' | 'cancellation' | null;
type Bucket = 'delivered' | 'openOverdue' | 'pending' | 'notDelivered' | 'rescheduled' | 'cancelled' | 'returned' | null;

interface Case {
    n: number;
    note: string;
    status: string;
    zone: Zone;
    level: Level;
    /** Day of July 2019 of the committed window (14:00–16:00 in Bolivia = 18:00–20:00Z); `bad` = it ends before it starts. */
    window: string | 'bad' | null;
    closedAt?: string;
    /** In the route batch that is still `in_execution`. */
    inOpenBatch?: boolean;
    /** Day of July 2019 of the window it had before a reschedule. */
    rescheduledFrom?: string;
    promise: OtdClass;
    deliveredAt: OtdClass;
    bucket: Bucket;
}

const day = (d: string) => `2019-07-${d}`;
const RANGE = { from: '2019-07-01', to: '2019-07-31' };

// The reference table. Bolivia is UTC-4: a window of day D is D 18:00Z–20:00Z.
const CASES: Case[] = [
    { n: 1, note: 'delivered inside the window, in a batch still running', status: 'delivered', zone: 'Z1', level: 'L1', window: '10', closedAt: `${day('10')}T19:00:00Z`, inOpenBatch: true, promise: 'on_time', deliveredAt: 'on_time', bucket: 'delivered' },
    { n: 2, note: 'delivered after the window', status: 'delivered', zone: 'Z1', level: 'L2', window: '10', closedAt: `${day('10')}T21:00:00Z`, promise: 'not_on_time', deliveredAt: 'not_on_time', bucket: 'delivered' },
    { n: 3, note: 'delivered before the window opened', status: 'delivered', zone: 'Z2', level: 'L1', window: '11', closedAt: `${day('11')}T17:00:00Z`, promise: 'not_on_time', deliveredAt: 'not_on_time', bucket: 'delivered' },
    { n: 4, note: 'still assigned, promise expired, in a batch still running', status: 'assigned', zone: 'Z1', level: 'L1', window: '11', inOpenBatch: true, promise: 'not_on_time', deliveredAt: null, bucket: 'openOverdue' },
    { n: 5, note: 'out for delivery, promise expired', status: 'out_for_delivery', zone: 'Z2', level: 'L2', window: '12', promise: 'not_on_time', deliveredAt: null, bucket: 'openOverdue' },
    { n: 6, note: 'failed attempt, in a batch still running', status: 'not_delivered', zone: 'Z1', level: 'L1', window: '12', closedAt: `${day('12')}T19:00:00Z`, inOpenBatch: true, promise: 'not_on_time', deliveredAt: null, bucket: 'notDelivered' },
    { n: 7, note: 'returned', status: 'returned', zone: 'Z2', level: 'L1', window: '13', closedAt: `${day('13')}T21:00:00Z`, promise: 'not_on_time', deliveredAt: null, bucket: 'returned' },
    { n: 8, note: 'returned to the warehouse', status: 'returned_to_warehouse', zone: 'Z1', level: 'L1', window: '13', closedAt: `${day('13')}T22:00:00Z`, promise: 'not_on_time', deliveredAt: null, bucket: 'returned' },
    { n: 9, note: 'cancelled before its promise expired', status: 'cancelled', zone: 'Z1', level: 'L1', window: '14', closedAt: `${day('14')}T15:00:00Z`, promise: 'excluded_cancellation', deliveredAt: 'cancellation', bucket: 'cancelled' },
    { n: 10, note: 'cancelled after its promise expired', status: 'cancelled', zone: 'Z2', level: 'L1', window: '14', closedAt: `${day('15')}T15:00:00Z`, promise: 'not_on_time', deliveredAt: 'cancellation', bucket: 'cancelled' },
    { n: 11, note: 'cancelled with no window to tell', status: 'cancelled', zone: 'Z1', level: 'L1', window: null, closedAt: `${day('16')}T15:00:00Z`, promise: 'unreconstructable', deliveredAt: 'cancellation', bucket: 'cancelled' },
    { n: 12, note: 'delivered with no window', status: 'delivered', zone: 'Z1', level: 'L1', window: null, closedAt: `${day('17')}T19:00:00Z`, promise: 'invalid_window', deliveredAt: 'invalid_window', bucket: 'delivered' },
    { n: 13, note: 'rescheduled, its new promise already expired', status: 'rescheduled', zone: 'Z2', level: 'L2', window: '18', rescheduledFrom: '08', promise: 'not_on_time', deliveredAt: null, bucket: 'rescheduled' },
    { n: 14, note: 'rescheduled and delivered inside the new window', status: 'delivered', zone: 'Z1', level: 'L1', window: '19', closedAt: `${day('19')}T19:00:00Z`, rescheduledFrom: '05', promise: 'on_time', deliveredAt: 'on_time', bucket: 'delivered' },
    { n: 15, note: 'assigned, window ends before it starts (invalid promise)', status: 'assigned', zone: 'Z1', level: 'L1', window: 'bad', promise: 'invalid_window', deliveredAt: null, bucket: 'pending' },
    { n: 16, note: 'not planned yet: no promise, placed by its creation (today), outside July', status: 'scheduled', zone: 'Z2', level: 'L1', window: null, promise: null, deliveredAt: null, bucket: null },
];

/** The OTD figures the table gives for a set of cases. */
function expectedOtd(cases: Case[], basis: 'promise' | 'deliveredAt') {
    const of = (cls: OtdClass) => cases.filter((c) => c[basis] === cls).length;
    const numerator = of('on_time');
    const denominator = numerator + of('not_on_time');
    const rescheduled = cases.filter((c) => c.rescheduledFrom && (c[basis] === 'on_time' || c[basis] === 'not_on_time')).length;
    return {
        numerator,
        denominator,
        n: denominator,
        percentage: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10,
        notOnTimeCount: denominator - numerator,
        invalidWindowCount: of('invalid_window'),
        excludedCancellations: basis === 'promise' ? of('excluded_cancellation') : of('cancellation'),
        unreconstructableCancellationCount: of('unreconstructable'),
        rescheduledPromiseCount: rescheduled,
    };
}

/** The backlog counts the table gives for a set of cases. */
function expectedCounts(cases: Case[]) {
    const counts = { delivered: 0, openOverdue: 0, pending: 0, notDelivered: 0, rescheduled: 0, cancelled: 0, returned: 0 };
    for (const c of cases) if (c.bucket) counts[c.bucket] += 1;
    return counts;
}

describe('Dashboard 1 against the reference table (e2e, ST-301.4)', () => {
    let app: INestApplication;
    let db: DataSource;
    let api: string;
    let token = '';
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3014-${run}`;
    const usernames = [`e2e_st3014_coord_${run}`.toLowerCase(), `e2e_st3014_driver_${run}`.toLowerCase()];
    const ids = { zone: {} as Record<Zone, number>, level: {} as Record<Level, number>, openBatch: 0, emptyBatch: 0, dispatch: {} as Record<number, number> };

    const call = (path: string, query: Record<string, string | number>) =>
        request(app.getHttpServer()).get(`/${api}${path}`).query(query).set('Authorization', `Bearer ${token}`);
    const otd = (query: Record<string, string | number> = {}) => call('/reports/otd', { ...RANGE, ...query });
    const backlog = (query: Record<string, string | number> = {}) => call('/reports/otd/backlog', { ...RANGE, ...query });
    /** Our cases always come with a zone filter, so dispatches of other suites never mix in. */
    const both = (zone: Zone) => ({ zoneId: ids.zone[zone] });
    const inZone = (zone: Zone) => CASES.filter((c) => c.zone === zone);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);

        const hash = await hashPassword('E2eTest1234!');
        const userIds: number[] = [];
        for (const [username, role] of [[usernames[0], 'coordinator'], [usernames[1], 'driver']] as const) {
            const [{ user_id }] = await db.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ((SELECT role_id FROM roles WHERE name = $1), $2, $3, $4, false) RETURNING user_id`,
                [role, `ST-301.4 ${role} ${run}`, username, hash],
            );
            userIds.push(user_id);
        }
        const login = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username: usernames[0], password: 'E2eTest1234!' });
        expect(login.status).toBe(200);
        token = login.body.accessToken;

        for (const zone of ['Z1', 'Z2'] as const) {
            [{ delivery_zone_id: ids.zone[zone] }] = await db.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`,
                [`Z3014${run}${zone}`.slice(0, 20), `E2E3014 ${run} ${zone}`]);
        }
        for (const [level, priority] of [['L1', 5], ['L2', 6]] as const) {
            [{ service_level_id: ids.level[level] }] = await db.query(
                `INSERT INTO service_levels (name, target_time_min, priority_level, active) VALUES ($1, 240, $2, true) RETURNING service_level_id`,
                [`E2E3014 ${level} ${run}`, priority]);
        }
        // A route batch still running with three of the dispatches, and one with none: neither is a dispatch.
        // One batch per driver and day (uq_route_batches_driver_shift_date), so each on its own day.
        for (const [key, shiftDate] of [['openBatch', '2019-07-10'], ['emptyBatch', '2019-07-11']] as const) {
            [{ route_batch_id: ids[key] }] = await db.query(
                `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, $2, 'in_execution') RETURNING route_batch_id`, [userIds[1], shiftDate]);
        }

        const [{ reschedule_reason_id: reasonId }] = await db.query(`SELECT reschedule_reason_id FROM reschedule_reasons ORDER BY reschedule_reason_id LIMIT 1`);
        for (const c of CASES) {
            const window = c.window === null ? [null, null]
                : c.window === 'bad' ? [`${day('20')}T20:00:00Z`, `${day('20')}T18:00:00Z`]
                : [`${day(c.window)}T18:00:00Z`, `${day(c.window)}T20:00:00Z`];
            const [{ dispatch_id }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, service_level_id, route_batch_id, source_order_ref,
                                         delivery_address, closed_at, scheduled_window_start, scheduled_window_end)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                         $2, $3, $4, $5, 'Dirección E2E ST-301.4', $6, $7, $8) RETURNING dispatch_id`,
                [c.status, ids.zone[c.zone], ids.level[c.level], c.inOpenBatch ? ids.openBatch : null, `${prefix}-${c.n}`, c.closedAt ?? null, window[0], window[1]],
            );
            ids.dispatch[c.n] = dispatch_id;
            if (c.rescheduledFrom) {
                await db.query(
                    `INSERT INTO dispatch_reschedules (dispatch_id, reschedule_reason_id, rescheduled_by_type, previous_window_start, previous_window_end,
                                                       new_window_start, new_window_end, created_at)
                     VALUES ($1, $2, 'coordinator', $3, $4, $5, $6, $7)`,
                    [dispatch_id, reasonId, `${day(c.rescheduledFrom)}T18:00:00Z`, `${day(c.rescheduledFrom)}T20:00:00Z`, window[0], window[1], `${day('02')}T12:00:00Z`],
                );
            }
        }
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await withEventPurge(db, { dispatchRefs: [`${prefix}%`], routeBatchIds: [ids.openBatch, ids.emptyBatch], userNames: usernames }, async (manager) => {
                await manager.query(`DELETE FROM dispatch_reschedules WHERE dispatch_id = ANY($1::int[])`, [Object.values(ids.dispatch)]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [[ids.openBatch, ids.emptyBatch]]);
                await manager.query(`DELETE FROM service_levels WHERE service_level_id = ANY($1::int[])`, [Object.values(ids.level)]);
                await manager.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = ANY($1::int[])`, [Object.values(ids.zone)]);
                await manager.query(`DELETE FROM users WHERE username = ANY($1::text[])`, [usernames]);
            });
        }
        await app?.close();
    });

    it('the reference table is consistent: every case has one bucket or none, and the hand totals are the documented ones', () => {
        // Hand totals of the whole table, written down so a change to the table is a visible change.
        expect(expectedOtd(CASES, 'promise')).toEqual({
            numerator: 2, denominator: 11, n: 11, percentage: 18.2, notOnTimeCount: 9, invalidWindowCount: 2,
            excludedCancellations: 1, unreconstructableCancellationCount: 1, rescheduledPromiseCount: 2,
        });
        expect(expectedOtd(CASES, 'deliveredAt')).toEqual({
            numerator: 2, denominator: 4, n: 4, percentage: 50, notOnTimeCount: 2, invalidWindowCount: 1,
            excludedCancellations: 3, unreconstructableCancellationCount: 0, rescheduledPromiseCount: 1,
        });
        expect(expectedCounts(CASES)).toEqual({ delivered: 5, openOverdue: 2, pending: 1, notDelivered: 1, rescheduled: 1, cancelled: 3, returned: 2 });
    });

    describe('OTD by promise and punctuality by completed delivery', () => {
        it.each(['Z1', 'Z2'] as const)('match the table for zone %s, in both bases', async (zone) => {
            for (const basis of ['promise', 'deliveredAt'] as const) {
                const res = await otd({ ...both(zone), basis });
                expect(res.status, `${zone} ${basis}`).toBe(200);
                const { reason: _reason, ...excluded } = res.body.metrics.excludedCancellations;
                expect({ ...res.body.metrics, excludedCancellations: excluded.count }, `${zone} ${basis}`).toEqual(expectedOtd(inZone(zone), basis));
            }
        });

        it('the two zones add up to the figures of the whole table (each dispatch is in one zone only)', async () => {
            for (const basis of ['promise', 'deliveredAt'] as const) {
                const z1 = (await otd({ ...both('Z1'), basis })).body.metrics;
                const z2 = (await otd({ ...both('Z2'), basis })).body.metrics;
                const all = expectedOtd(CASES, basis);
                expect(z1.numerator + z2.numerator).toBe(all.numerator);
                expect(z1.denominator + z2.denominator).toBe(all.denominator);
                expect(z1.invalidWindowCount + z2.invalidWindowCount).toBe(all.invalidWindowCount);
                expect(z1.excludedCancellations.count + z2.excludedCancellations.count).toBe(all.excludedCancellations);
            }
        });

        it('match the table filtered by service level and by current status', async () => {
            for (const level of ['L1', 'L2'] as const) {
                for (const zone of ['Z1', 'Z2'] as const) {
                    const res = await otd({ ...both(zone), serviceLevelId: ids.level[level] });
                    const { excludedCancellations, ...metrics } = res.body.metrics;
                    const { excludedCancellations: expectedExcluded, ...expected } = expectedOtd(inZone(zone).filter((c) => c.level === level), 'promise');
                    expect(metrics, `${zone} ${level}`).toEqual(expected);
                    expect(excludedCancellations.count, `${zone} ${level}`).toBe(expectedExcluded);
                }
            }
            for (const status of ['delivered', 'cancelled', 'assigned']) {
                const res = await otd({ ...both('Z1'), status });
                const { excludedCancellations, ...metrics } = res.body.metrics;
                const { excludedCancellations: expectedExcluded, ...expected } = expectedOtd(inZone('Z1').filter((c) => c.status === status), 'promise');
                expect(metrics, status).toEqual(expected);
                expect(excludedCancellations.count, status).toBe(expectedExcluded);
            }
        });

        it('punctuality by completed delivery agrees with /reports/sla for the same zone', async () => {
            const sla = (await call('/reports/sla', { ...RANGE, groupBy: 'zone' })).body;
            for (const zone of ['Z1', 'Z2'] as const) {
                const row = sla.rows.find((r: { groupId: number }) => r.groupId === ids.zone[zone]);
                const metrics = (await otd({ ...both(zone), basis: 'deliveredAt' })).body.metrics;
                // Same on-time rule; /reports/sla counts a delivery without window as delivered, here it is shown apart.
                expect(metrics.numerator, zone).toBe(row.onTimeCount);
                expect(metrics.denominator + metrics.invalidWindowCount, zone).toBe(row.deliveredCount);
            }
        });

        it('never invents the first-attempt rate (these dispatches have no events: no rate), and says «Sin datos» for a period with nothing', async () => {
            const res = await otd(both('Z1'));
            expect(res.body.firstAttempt).toMatchObject({ numerator: 0, denominator: 0, percentage: null, coverage: { complete: expect.any(Boolean) } });
            const empty = await otd({ ...both('Z1'), from: '2019-06-01', to: '2019-06-30' });
            expect(empty.body).toMatchObject({ empty: true, metrics: { numerator: 0, denominator: 0, n: 0, percentage: null } });
        });
    });

    describe('backlog by dispatch', () => {
        it.each(['Z1', 'Z2'] as const)('counts each dispatch of zone %s in exactly the bucket of the table', async (zone) => {
            const body = (await backlog(both(zone))).body;
            const expected = expectedCounts(inZone(zone));
            expect(body.counts).toEqual(expected);
            expect(body.backlogTotal).toBe(expected.openOverdue + expected.pending);
            // Mutually exclusive buckets: their sum is the number of dispatches of the period, each counted once.
            expect(Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(inZone(zone).filter((c) => c.bucket).length);
        });

        it('splits the open ones without overlap: stages add up to pending, ages to the overdue ones, the list to its count', async () => {
            for (const zone of ['Z1', 'Z2'] as const) {
                const body = (await backlog(both(zone))).body;
                const stageTotal = body.pendingByStage.reduce((sum: number, stage: { total: number }) => sum + stage.total, 0);
                expect(stageTotal, zone).toBe(body.counts.pending);
                for (const stage of body.pendingByStage) {
                    expect(Object.values(stage.byAge as Record<string, number>).reduce((a, b) => a + b, 0), `${zone} ${stage.stage}`).toBe(stage.total);
                }
                expect(Object.values(body.openOverdueByAge as Record<string, number>).reduce((a, b) => a + b, 0), zone).toBe(body.counts.openOverdue);
                const listed = body.openOverdue.map((row: { dispatchId: number }) => row.dispatchId);
                const expectedOverdue = inZone(zone).filter((c) => c.bucket === 'openOverdue').map((c) => ids.dispatch[c.n]);
                expect(listed.sort(), zone).toEqual(expectedOverdue.sort());
            }
            const z1Stages = (await backlog(both('Z1'))).body.pendingByStage;
            expect(z1Stages.map((stage: { stage: string; total: number }) => [stage.stage, stage.total])).toEqual([['assigned', 1]]);
        });

        it('counts the dispatches of a batch still running one by one, by their own status, and a batch is never a unit', async () => {
            const body = (await backlog(both('Z1'))).body;
            const inBatch = CASES.filter((c) => c.inOpenBatch);
            expect(inBatch.map((c) => c.bucket)).toEqual(['delivered', 'openOverdue', 'notDelivered']);
            // Z1 holds the three dispatches of the running batch and the empty batch adds nothing: the total is dispatches only.
            const total = Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0);
            expect(total).toBe(inZone('Z1').filter((c) => c.bucket).length);
            expect(body.counts.delivered).toBe(inZone('Z1').filter((c) => c.bucket === 'delivered').length);
        });

        it('filtering by current status gives only that bucket', async () => {
            for (const [status, bucket] of [['delivered', 'delivered'], ['cancelled', 'cancelled'], ['returned_to_warehouse', 'returned'], ['rescheduled', 'rescheduled']] as const) {
                for (const zone of ['Z1', 'Z2'] as const) {
                    const counts = (await backlog({ ...both(zone), status })).body.counts;
                    const expected = inZone(zone).filter((c) => c.status === status).length;
                    expect(counts[bucket], `${zone} ${status}`).toBe(expected);
                    expect(Object.values(counts as Record<string, number>).reduce((a, b) => a + b, 0), `${zone} ${status}`).toBe(expected);
                }
            }
        });

        it('a dispatch with no promise yet is not placed in a past period, and an empty period is «Sin datos»', async () => {
            const z2 = (await backlog(both('Z2'))).body;
            expect(Object.values(z2.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(inZone('Z2').length - 1);
            const empty = (await backlog({ ...both('Z1'), from: '2019-06-01', to: '2019-06-30' })).body;
            expect(empty).toMatchObject({ empty: true, backlogTotal: 0, openOverdue: [] });
        });
    });
});
