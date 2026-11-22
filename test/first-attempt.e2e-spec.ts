// ST-301.3 — Real HTTP/PostgreSQL acceptance checks for the delivery at the first attempt in GET /reports/otd and the attempts
// of the open overdue list in GET /reports/otd/backlog (ES-301). The attempts are rebuilt from dispatch_events: no table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// March 2020: the past, so every promise has expired and no other suite writes there. Bolivia is UTC-4: 14:00-16:00 there is 18:00Z-20:00Z.
const win = (day: string): [string, string] => [`2020-03-${day}T18:00:00Z`, `2020-03-${day}T20:00:00Z`];
const at = (day: string, time: string) => `2020-03-${day}T${time}:00Z`;
const COVERED = { from: '2020-03-05', to: '2020-03-31' };
const NOT_COVERED = { from: '2020-03-01', to: '2020-03-31' };

describe('first-attempt delivery in /reports/otd and /reports/otd/backlog (e2e, ST-301.3)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    let token = '';
    const run = Date.now().toString(36).toUpperCase();
    const prefix = `ST3013-${run}`;
    const zone = { ATT: 0, OTHER: 0, EMPTY: 0 };
    const dispatchOf: Record<number, number> = {};
    const statusIds: Record<string, number> = {};
    let deliveryTypeId = 0;

    const otd = (query: Record<string, string | number>, path = '') =>
        request(app.getHttpServer()).get(`/${apiPrefix}/reports/otd${path}`).query(query).set('Authorization', `Bearer ${token}`);

    const insertDispatch = async (n: number, status: string, window: [string, string] | null, options: { closedAt?: string; zoneId?: number } = {}) => {
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, source_order_ref, delivery_address, closed_at, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, 'Dirección E2E ST-301.3', $5, $6, $7) RETURNING dispatch_id`,
            [deliveryTypeId, statusIds[status], options.zoneId ?? zone.ATT, `${prefix}-${n}`, options.closedAt ?? null, window?.[0] ?? null, window?.[1] ?? null],
        );
        dispatchOf[n] = id;
    };

    /** A `status_changed` event as the backend writes it: `metadata.status` (the planner writes `to`), previous status and author. */
    const event = async (n: number, status: string, previous: string | null, createdAt: string, options: { shape?: 'status' | 'to'; clientEventId?: string; reason?: string; actorType?: 'user' | null } = {}) => {
        const metadata = { previousStatus: previous, [options.shape ?? 'status']: status, ...(options.reason ? { reasonCode: options.reason } : {}) };
        await dataSource.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, client_event_id, actor_type, reason, metadata, created_at)
             VALUES ($1, 'status_changed', $2, $3, $4, $5::jsonb, $6)`,
            [dispatchOf[n], options.clientEventId ?? null, options.actorType === undefined ? 'user' : options.actorType, options.reason ?? null, JSON.stringify(metadata), createdAt],
        );
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'coordinator'`);
        await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
            [roleId, `ST-301.3 coordinator ${run}`, `e2e_st3013_coordinator_${run}`, await hashPassword('E2eTest1234')],
        );
        const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st3013_coordinator_${run}`, password: 'E2eTest1234' });
        expect(login.status, 'login').toBe(200);
        token = login.body.accessToken as string;

        for (const key of ['ATT', 'OTHER', 'EMPTY'] as const) {
            const [{ delivery_zone_id: id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 60) RETURNING delivery_zone_id`, [`Z3013${run}${key}`, `E2E3013 ${run} ${key}`]);
            zone[key] = id;
        }
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        // 1: before the range. Its trip (March 2) is the first one the backend wrote: the instrumented period starts there.
        await insertDispatch(1, 'delivered', win('03'), { closedAt: at('03', '19:00') });
        // Older trips that do NOT count as instrumented: one with no author (before ST-49.4) and one with no previous status.
        await event(1, 'in_transit', 'out_for_delivery', at('01', '10:00'), { actorType: null });
        await event(1, 'in_transit', null, at('01', '11:00'));
        await event(1, 'in_transit', 'out_for_delivery', at('02', '17:00'));
        await event(1, 'delivered', 'in_transit', at('03', '19:00'));

        // 2: first attempt on time.  3: first attempt late.
        await insertDispatch(2, 'delivered', win('10'), { closedAt: at('10', '19:00') });
        await event(2, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(2, 'delivered', 'in_transit', at('10', '19:00'));
        await insertDispatch(3, 'delivered', win('10'), { closedAt: at('10', '21:00') });
        await event(3, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(3, 'delivered', 'in_transit', at('10', '21:00'));

        // 4: failed the first time, delivered on the second: the first attempt is the failed one.
        await insertDispatch(4, 'delivered', win('10'), { closedAt: at('11', '19:00') });
        await event(4, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(4, 'not_delivered', 'in_transit', at('10', '18:30'));
        await event(4, 'in_transit', 'rescheduled', at('11', '17:00'));
        await event(4, 'delivered', 'in_transit', at('11', '19:00'));

        // 5: a not_delivered and the incident that caused it (its reason consumes an attempt): ONE attempt. Open and overdue.
        await insertDispatch(5, 'incident', win('10'));
        await event(5, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(5, 'not_delivered', 'in_transit', at('10', '18:00'));
        await event(5, 'incident', 'in_transit', at('10', '18:01'), { clientEventId: randomUUID(), reason: 'INC-CUST-ABSENT' });

        // 6: the delivered event written twice (a repeated status): one attempt.
        await insertDispatch(6, 'delivered', win('10'), { closedAt: at('10', '19:00') });
        await event(6, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(6, 'delivered', 'in_transit', at('10', '19:00'));
        await event(6, 'delivered', 'delivered', at('10', '19:00'));

        // 7: open and overdue, no trip yet: its first chance has not happened.
        await insertDispatch(7, 'assigned', win('12'));

        // 8: delivered with no trip event (history from before the instrumentation): cannot be rebuilt.
        await insertDispatch(8, 'delivered', win('12'), { closedAt: at('12', '19:00') });
        await event(8, 'delivered', 'in_transit', at('12', '19:00'));

        // 9: an incident whose reason does NOT consume an attempt: no attempt, still open.
        await insertDispatch(9, 'incident', win('11'));
        await event(9, 'in_transit', 'out_for_delivery', at('11', '17:00'));
        await event(9, 'incident', 'in_transit', at('11', '17:30'), { clientEventId: randomUUID(), reason: 'INC-PROD-DAMAGED' });

        // 14: delivered and with no event at all (written before the events existed): not «not yet», it cannot be rebuilt.
        await insertDispatch(14, 'delivered', win('14'), { closedAt: at('14', '19:00') });

        // 10: delivered at the first attempt with no valid window: placed by its closing time.
        await insertDispatch(10, 'delivered', null, { closedAt: at('15', '19:00') });
        await event(10, 'in_transit', 'out_for_delivery', at('15', '17:00'));
        await event(10, 'delivered', 'in_transit', at('15', '19:00'));

        // 12: on time, with the new status written as `metadata.to` (the planner's shape).
        await insertDispatch(12, 'delivered', win('20'), { closedAt: at('20', '19:00') });
        await event(12, 'in_transit', 'out_for_delivery', at('20', '17:00'), { shape: 'to' });
        await event(12, 'delivered', 'in_transit', at('20', '19:00'), { shape: 'to' });

        // 13: another zone, on time: only seen when the zone filter is not applied.
        await insertDispatch(13, 'delivered', win('10'), { closedAt: at('10', '19:00'), zoneId: zone.OTHER });
        await event(13, 'in_transit', 'out_for_delivery', at('10', '17:00'));
        await event(13, 'delivered', 'in_transit', at('10', '19:00'));
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: [], userNames: [`e2e_st3013_%_${run}`] }, async (manager) => {
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z3013${run}%`]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st3013_%_${run}`]);
            });
        }
        await app?.close();
    });

    describe('GET /reports/otd — firstAttempt', () => {
        it('counts how each first attempt went, with the repeated and correlated events counted once', async () => {
            const response = await otd({ ...COVERED, zoneId: zone.ATT });

            expect(response.status).toBe(200);
            expect(response.body.firstAttempt).toMatchObject({
                available: true,
                reason: null,
                dateBasis: 'promise_window_end',
                onTimeCount: 3, // 2, 6 (delivered written twice) and 12 (planner shape)
                lateCount: 1, // 3
                deliveredWithoutWindowCount: 1, // 10
                failedCount: 2, // 4 (delivered only on its second attempt) and 5 (not_delivered + incident = one attempt)
                noAttemptYetCount: 2, // 7 and 9 (its incident does not consume an attempt)
                notReconstructableCount: 2, // 8 (a delivered with no trip) and 14 (delivered with no event at all)
                numerator: 5,
                denominator: 7,
                n: 7,
                percentage: 71.4,
                coverage: { from: at('02', '17:00').replace(':00Z', ':00.000Z'), complete: true },
            });
        });

        it('keeps a dispatch of another zone out of the answer when the zone is filtered, and counts it when it is not', async () => {
            const zoned = await otd({ ...COVERED, zoneId: zone.OTHER });
            expect(zoned.body.firstAttempt).toMatchObject({ onTimeCount: 1, denominator: 1, percentage: 100 });
        });

        it('is the same block for both bases of the OTD', async () => {
            const promise = await otd({ ...COVERED, zoneId: zone.ATT, basis: 'promise' });
            const deliveredAt = await otd({ ...COVERED, zoneId: zone.ATT, basis: 'deliveredAt' });
            expect(deliveredAt.body.firstAttempt).toEqual(promise.body.firstAttempt);
        });

        it('is N/D, with the counts, when the range starts before the instrumented period', async () => {
            const response = await otd({ ...NOT_COVERED, zoneId: zone.ATT });
            expect(response.status).toBe(200);
            expect(response.body.firstAttempt).toMatchObject({
                available: false,
                reason: 'attempt_coverage_incomplete',
                percentage: null,
                coverage: { complete: false },
                onTimeCount: 4, // the five of the covered range plus dispatch 1
            });
        });

        it('says «Sin datos» (available, null) when no dispatch is in the range', async () => {
            const response = await otd({ ...COVERED, zoneId: zone.EMPTY });
            expect(response.body.firstAttempt).toMatchObject({ available: true, denominator: 0, percentage: null, noAttemptYetCount: 0 });
        });
    });

    describe('GET /reports/otd/backlog — attempts of the open overdue list', () => {
        it('shows the attempts used and the first result of each open overdue dispatch', async () => {
            const response = await otd({ ...COVERED, zoneId: zone.ATT }, '/backlog');

            expect(response.status).toBe(200);
            const rows = response.body.openOverdue.map((row: { dispatchId: number; attemptsUsed: number | null; firstAttemptResult: string }) => [row.dispatchId, row.attemptsUsed, row.firstAttemptResult]);
            expect(rows).toEqual([
                [dispatchOf[5], 1, 'failed'], // promise March 10: not_delivered and its incident are one attempt
                [dispatchOf[9], 0, 'no_attempt_yet'], // promise March 11: an incident that does not consume an attempt
                [dispatchOf[7], 0, 'no_attempt_yet'], // promise March 12: never left
            ]);
        });
    });
});
