// ST-69.3 — immutability, order and atomicity of the order/dispatch history (RF-A36), against real HTTP + PostgreSQL.
// Complements order-dispatch-events.e2e-spec.ts (ST-69.2) with what the test task asks and that suite leaves out:
// concurrent transitions, a rollback AFTER the event was written, the order/dispatch/batch keys, temporal order and
// keyset paging, the request correlation, and read-only access for the application role (TRUNCATE included).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { OrderDispatchEventsService } from '../src/modules/audit/order-dispatch-events/services/order-dispatch-events.service.js';
import { ORDER_DISPATCH_ACTIONS } from '../src/modules/audit/order-dispatch-events/domain/order-dispatch-event-actions.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

interface HistoryRow {
    order_dispatch_event_id: string;
    action: string;
    previous_status: string | null;
    new_status: string | null;
    dispatch_id: number | null;
    route_batch_id: number | null;
    source_order_ref: string;
    correlation_id: string;
    occurred_at: Date;
}

describe('order/dispatch history: immutability, order and atomicity (e2e, ST-69.3)', () => {
    let app: INestApplication;
    let db: DataSource;
    let events: OrderDispatchEventsService;
    let api = '';
    let token = '';
    let driverId = 0;
    let shiftDay = 0;
    let sequence = 0;
    const tag = Date.now().toString(36).toUpperCase();
    const prefix = `ST693-${tag}`;
    const trackingBase = 10_000 + Math.floor(Math.random() * 80_000);
    const batchIds: number[] = [];
    const username = `e2e_st693_driver_${tag}`.toLowerCase();

    const patch = (id: number, status: string, options: { requestId?: string; occurredAt?: Date } = {}) => {
        const call = request(app.getHttpServer()).patch(`/${api}/dispatches/${id}/status`).set('Authorization', `Bearer ${token}`);
        if (options.requestId) call.set('X-Request-Id', options.requestId);
        return call.send({ status, eventId: uuidv7(), occurredAt: (options.occurredAt ?? new Date()).toISOString(), lat: -16.5, lng: -68.1, accuracy: 8.4 });
    };

    /** A route batch already started, in execution, with `count` dispatches out for delivery. */
    const newBatch = async (count: number) => {
        const [{ route_batch_id: batchId }] = await db.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2042-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [driverId, ++shiftDay],
        );
        batchIds.push(batchId);
        await db.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, metadata) VALUES ($1, 'route_started', 'system', $2::jsonb)`,
            [batchId, JSON.stringify({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })],
        );
        const dispatches: Array<{ id: number; ref: string }> = [];
        for (let i = 0; i < count; i++) {
            const ref = `${prefix}-${++sequence}`;
            const [{ dispatch_id: id }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code, delivery_address, evidence_policy)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'out_for_delivery'),
                         $1, $2, $3, $4, 'Dirección E2E ST-69.3', 'hand_delivery_standard') RETURNING dispatch_id`,
                [batchId, i + 1, ref, `DSP-2042-${String(trackingBase + sequence).padStart(5, '0')}`],
            );
            dispatches.push({ id, ref });
        }
        return { batchId: batchId as number, dispatches };
    };

    const withEvidence = async (dispatchId: number) => db.query(
        `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url) VALUES ($1, $2, 'signature', 'https://example.test/e2e')`,
        [uuidv7(), dispatchId],
    );

    const historyOf = async (where: string, params: unknown[]): Promise<HistoryRow[]> => db.query(
        `SELECT order_dispatch_event_id, action, previous_status, new_status, dispatch_id, route_batch_id, source_order_ref, correlation_id, occurred_at
           FROM order_dispatch_events WHERE ${where} ORDER BY occurred_at, created_at, order_dispatch_event_id`, params);
    const statusOf = async (id: number) =>
        (await db.query(`SELECT ds.name FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0].name;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        api = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(api);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        events = moduleRef.get(OrderDispatchEventsService);

        [{ user_id: driverId }] = await db.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
             VALUES ((SELECT role_id FROM roles WHERE name = 'driver'), $1, $2, $3, false) RETURNING user_id`,
            [`ST-69.3 driver ${tag}`, username, await hashPassword('E2eTest1234!')],
        );
        const login = await request(app.getHttpServer()).post(`/${api}/auth/login`).send({ username, password: 'E2eTest1234!' });
        expect(login.status).toBe(200);
        token = login.body.accessToken;
    });

    afterAll(async () => {
        if (db?.isInitialized) {
            await db.query(`DROP TRIGGER IF EXISTS trg_e2e_st693_close_fail ON route_batches`);
            await db.query(`DROP FUNCTION IF EXISTS fn_e2e_st693_close_fail()`);
            await db.query(`DROP TRIGGER IF EXISTS trg_e2e_st693_slow ON order_dispatch_events`);
            await db.query(`DROP FUNCTION IF EXISTS fn_e2e_st693_slow()`);
            await withEventPurge(db, { dispatchRefs: [`${prefix}%`], routeBatchIds: batchIds, userNames: [username] }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM delivery_evidences WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM users WHERE username = $1`, [username]);
            });
        }
        await app?.close();
    });

    describe('concurrency', () => {
        it('dispatches of one route leaving at the same time: one wins, the rest are refused, and only the winner has an event', async () => {
            // Eight at once, and each history write of this batch held for 300 ms, so the race window is wide open: without the
            // lock on the route, every request would read «no stop in transit» while the others wait and all would pass.
            const { batchId, dispatches } = await newBatch(8);
            await db.query(`CREATE OR REPLACE FUNCTION fn_e2e_st693_slow() RETURNS trigger AS $$
                BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$ LANGUAGE plpgsql`);
            await db.query(`CREATE TRIGGER trg_e2e_st693_slow BEFORE INSERT ON order_dispatch_events
                FOR EACH ROW WHEN (NEW.route_batch_id = ${Number(batchId)}) EXECUTE FUNCTION fn_e2e_st693_slow()`);
            let responses: Awaited<ReturnType<typeof patch>>[];
            try {
                responses = await Promise.all(dispatches.map((d) => patch(d.id, 'in_transit')));
            } finally {
                await db.query(`DROP TRIGGER IF EXISTS trg_e2e_st693_slow ON order_dispatch_events`);
                await db.query(`DROP FUNCTION IF EXISTS fn_e2e_st693_slow()`);
            }
            expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
            for (const res of responses.filter((r) => r.status !== 200)) {
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('ANOTHER_DISPATCH_IN_TRANSIT');
            }

            const winner = dispatches[responses.findIndex((res) => res.status === 200)]!;
            expect(await historyOf('dispatch_id = $1', [winner.id])).toMatchObject([{ action: 'dispatch.departed', new_status: 'in_transit' }]);
            expect(await historyOf('route_batch_id = $1', [batchId])).toHaveLength(1);
            for (const d of dispatches.filter((x) => x.id !== winner.id)) expect(await statusOf(d.id)).toBe('out_for_delivery');
        });

        it('the same transition sent twice at once (a retried request) leaves one state change and one event', async () => {
            const { dispatches: [d] } = await newBatch(1);
            const responses = await Promise.all([patch(d!.id, 'in_transit'), patch(d!.id, 'in_transit')]);
            expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
            expect(await historyOf('dispatch_id = $1', [d!.id])).toHaveLength(1);
            expect(await db.query(`SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'status_changed'`, [d!.id])).toHaveLength(1);
        });

        it('concurrent work on different dispatches keeps one event per committed transition, in the order of each dispatch', async () => {
            const routes = await Promise.all([newBatch(1), newBatch(1), newBatch(1)]);
            const ids = routes.map((route) => route.dispatches[0]!.id);
            expect((await Promise.all(ids.map((id) => patch(id, 'in_transit')))).every((res) => res.status === 200)).toBe(true);
            await Promise.all(ids.map(withEvidence));
            expect((await Promise.all(ids.map((id) => patch(id, 'delivered')))).every((res) => res.status === 200)).toBe(true);
            for (const id of ids) {
                expect((await historyOf('dispatch_id = $1', [id])).map((row) => row.action)).toEqual(['dispatch.departed', 'dispatch.delivery_result']);
            }
        });
    });

    describe('atomicity', () => {
        it('a failure AFTER the event was written rolls the event back with the transition: no orphan event', async () => {
            const { batchId, dispatches: [d] } = await newBatch(1);
            expect((await patch(d!.id, 'in_transit')).status).toBe(200);
            await withEvidence(d!.id);
            // Delivering the only dispatch closes its batch, after the history event of the delivery is inserted.
            await db.query(`CREATE OR REPLACE FUNCTION fn_e2e_st693_close_fail() RETURNS trigger AS $$
                BEGIN RAISE EXCEPTION 'e2e: batch closing failed'; END; $$ LANGUAGE plpgsql`);
            await db.query(`CREATE TRIGGER trg_e2e_st693_close_fail BEFORE UPDATE ON route_batches
                FOR EACH ROW WHEN (OLD.route_batch_id = ${Number(batchId)}) EXECUTE FUNCTION fn_e2e_st693_close_fail()`);
            try {
                expect((await patch(d!.id, 'delivered')).status).toBe(500);
            } finally {
                await db.query(`DROP TRIGGER IF EXISTS trg_e2e_st693_close_fail ON route_batches`);
                await db.query(`DROP FUNCTION IF EXISTS fn_e2e_st693_close_fail()`);
            }
            expect(await statusOf(d!.id)).toBe('in_transit');
            expect((await historyOf('dispatch_id = $1', [d!.id])).map((row) => row.action)).toEqual(['dispatch.departed']);

            // Once the batch can close again, the same delivery goes through and leaves exactly its own event.
            expect((await patch(d!.id, 'delivered')).status).toBe(200);
            expect((await historyOf('dispatch_id = $1', [d!.id])).map((row) => row.action)).toEqual(['dispatch.departed', 'dispatch.delivery_result']);
        });

        it('an event for a dispatch that does not exist is never written, and nothing else in its transaction survives', async () => {
            const ref = `${prefix}-ghost`;
            await expect(db.transaction(async (manager) => {
                await events.record({ sourceOrderRef: ref, action: ORDER_DISPATCH_ACTIONS.CREATED }, { manager });
                await events.recordForDispatch(2_000_000_000, { action: ORDER_DISPATCH_ACTIONS.CANCELLED }, { manager });
            })).rejects.toThrow();
            expect(await historyOf('source_order_ref = $1', [ref])).toEqual([]);
        });
    });

    describe('order, dispatch and batch keys', () => {
        it('links every event to its order, its own dispatch and the batch it was in at that moment', async () => {
            const first = await newBatch(1);
            const second = await newBatch(1);
            const d = first.dispatches[0]!;
            expect((await patch(d.id, 'in_transit')).status).toBe(200);
            // The dispatch is moved to another route (as a replanning would); its next event belongs to the new batch.
            await db.query(`UPDATE dispatches SET route_batch_id = $1, sequence_order = 2 WHERE dispatch_id = $2`, [second.batchId, d.id]);
            await withEvidence(d.id);
            expect((await patch(d.id, 'delivered')).status).toBe(200);

            const rows = await historyOf('dispatch_id = $1', [d.id]);
            expect(rows.map((row) => [row.action, row.source_order_ref, row.route_batch_id])).toEqual([
                ['dispatch.departed', d.ref, first.batchId],
                ['dispatch.delivery_result', d.ref, second.batchId],
            ]);
            // The first event keeps the batch it was written with: a later move does not rewrite history.
            expect((await historyOf('route_batch_id = $1', [first.batchId])).map((row) => row.dispatch_id)).toEqual([d.id]);
        });

        it('reads by order across its dispatches, and by dispatch only its own', async () => {
            const { dispatches: [delivery] } = await newBatch(1);
            const [{ dispatch_id: pickupId }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, tracking_code)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'pending'), $1, 'Dirección E2E ST-69.3', $2)
                 RETURNING dispatch_id`,
                [delivery!.ref, `DSP-2042-${String(trackingBase + 90_000 - sequence).padStart(5, '0')}`],
            );
            expect((await patch(delivery!.id, 'in_transit')).status).toBe(200);
            await db.transaction(async (manager) => {
                await events.recordForDispatch(pickupId, { action: ORDER_DISPATCH_ACTIONS.CREATED, newStatus: 'pending' }, { manager });
            });

            const byOrder = await events.findByOrder(delivery!.ref);
            expect(byOrder.map((event) => event.dispatchId).sort()).toEqual([delivery!.id, pickupId].sort());
            expect(byOrder.every((event) => event.sourceOrderRef === delivery!.ref)).toBe(true);
            expect((await events.findByDispatch(pickupId)).map((event) => event.action)).toEqual(['dispatch.created']);
            expect((await events.findByDispatch(delivery!.id)).map((event) => event.action)).toEqual(['dispatch.departed']);
        });
    });

    describe('temporal order and paging', () => {
        it('reads by the time the fact happened, not by arrival, and breaks ties the same way every time', async () => {
            const { dispatches: [d] } = await newBatch(1);
            const at = (minute: number) => new Date(Date.UTC(2042, 0, 1, 12, minute));
            // Arrival order: 12:30, 12:10 (a late sync), 12:20, then two at 12:40 (a tie).
            await db.transaction(async (manager) => {
                for (const [minute, action] of [[30, 'DEPARTED'], [10, 'CREATED'], [20, 'ASSIGNED'], [40, 'DELIVERY_RESULT'], [40, 'RESCHEDULED']] as const) {
                    await events.recordForDispatch(d!.id, { action: ORDER_DISPATCH_ACTIONS[action], occurredAt: at(minute) }, { manager });
                }
            });
            const read = (await events.findByDispatch(d!.id)).map((event) => [event.occurredAt.toISOString().slice(11, 16), event.action]);
            expect(read.slice(0, 3)).toEqual([['12:10', 'dispatch.created'], ['12:20', 'dispatch.assigned'], ['12:30', 'dispatch.departed']]);
            expect(read.slice(3).map(([time]) => time)).toEqual(['12:40', '12:40']);
            // The tie is broken by insertion time and id: the same answer every time it is read.
            const again = (await events.findByDispatch(d!.id)).map((event) => event.id);
            expect((await events.findByDispatch(d!.id)).map((event) => event.id)).toEqual(again);
        });

        it('pages a long history by time (keyset on the dispatch + time index) without gaps or repeats', async () => {
            const { dispatches: [d] } = await newBatch(1);
            await db.transaction(async (manager) => {
                for (let minute = 0; minute < 11; minute++) {
                    await events.recordForDispatch(d!.id, { action: ORDER_DISPATCH_ACTIONS.ASSIGNED, occurredAt: new Date(Date.UTC(2042, 0, 2, 9, minute % 5 === 0 ? 0 : minute)) }, { manager });
                }
            });
            const all = (await historyOf('dispatch_id = $1', [d!.id])).map((row) => row.order_dispatch_event_id);
            const paged: string[] = [];
            // The cursor is the last event of the page itself: its timestamps stay in the database at full (microsecond)
            // precision instead of round-tripping through a millisecond JavaScript Date.
            let cursor: string | null = null;
            for (let pages = 0; pages < 10; pages++) {
                const page: Array<{ order_dispatch_event_id: string }> = await db.query(
                    `SELECT e.order_dispatch_event_id FROM order_dispatch_events e
                      WHERE e.dispatch_id = $1
                        AND ($2::uuid IS NULL OR (e.occurred_at, e.created_at, e.order_dispatch_event_id) >
                            (SELECT c.occurred_at, c.created_at, c.order_dispatch_event_id FROM order_dispatch_events c WHERE c.order_dispatch_event_id = $2::uuid))
                      ORDER BY e.occurred_at, e.created_at, e.order_dispatch_event_id LIMIT 4`,
                    [d!.id, cursor],
                );
                if (page.length === 0) break;
                paged.push(...page.map((row) => row.order_dispatch_event_id));
                cursor = page[page.length - 1]!.order_dispatch_event_id;
            }
            expect(paged).toEqual(all);
            expect(new Set(paged).size).toBe(11);

            const plan: Array<{ 'QUERY PLAN': string }> = await db.transaction(async (manager) => {
                await manager.query('SET LOCAL enable_seqscan = off');
                return manager.query(`EXPLAIN SELECT * FROM order_dispatch_events WHERE dispatch_id = $1 AND occurred_at >= $2 ORDER BY occurred_at`, [d!.id, new Date(Date.UTC(2042, 0, 2))]);
            });
            expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('idx_order_dispatch_events_dispatch_occurred');
        });
    });

    describe('correlation', () => {
        it('each event carries the id of the request that caused it, the client\'s or the one the server generated and returned', async () => {
            const { dispatches: [d] } = await newBatch(1);
            const sent = await patch(d!.id, 'in_transit', { requestId: `req-st693-${tag}` });
            expect(sent.headers['x-request-id']).toBe(`req-st693-${tag}`);
            await withEvidence(d!.id);
            const generated = await patch(d!.id, 'delivered');
            const serverId = generated.headers['x-request-id'];
            expect(serverId).toMatch(/^[0-9a-f-]{36}$/);

            const rows = await historyOf('dispatch_id = $1', [d!.id]);
            expect(rows.map((row) => row.correlation_id)).toEqual([`req-st693-${tag}`, serverId]);
        });
    });

    describe('read-only for the application', () => {
        const asApp = (sql: string, params: unknown[] = []) => db.transaction(async (manager) => {
            await manager.query('SET LOCAL ROLE dispatch_app');
            return manager.query(sql, params);
        });

        it('the application role reads and appends, but cannot update, delete or truncate', async () => {
            const { dispatches: [d] } = await newBatch(1);
            expect((await patch(d!.id, 'in_transit')).status).toBe(200);
            expect(await asApp(`SELECT count(*)::int AS n FROM order_dispatch_events WHERE dispatch_id = $1`, [d!.id])).toEqual([{ n: 1 }]);
            await asApp(
                `INSERT INTO order_dispatch_events (order_dispatch_event_id, source_order_ref, dispatch_id, action, result, correlation_id, occurred_at)
                 VALUES ($1, $2, $3, 'dispatch.assigned', 'success', 'req-app-insert', NOW())`,
                [uuidv7(), d!.ref, d!.id],
            );
            for (const sql of [
                `UPDATE order_dispatch_events SET new_status = 'delivered' WHERE dispatch_id = $1`,
                `DELETE FROM order_dispatch_events WHERE dispatch_id = $1`,
            ]) await expect(asApp(sql, [d!.id]), sql).rejects.toThrow(/permission denied/);
            await expect(asApp('TRUNCATE order_dispatch_events')).rejects.toThrow(/permission denied/);
            expect(await historyOf('dispatch_id = $1', [d!.id])).toHaveLength(2);
        });

        it('not even the owner can rewrite an event: the triggers refuse UPDATE and DELETE, with or without the purge flag', async () => {
            const { dispatches: [d] } = await newBatch(1);
            expect((await patch(d!.id, 'in_transit')).status).toBe(200);
            const [before] = await historyOf('dispatch_id = $1', [d!.id]);
            for (const purge of [false, true]) {
                await expect(db.transaction(async (manager) => {
                    if (purge) await manager.query(`SET LOCAL app.allow_event_purge = 'on'`);
                    await manager.query(`UPDATE order_dispatch_events SET new_status = 'delivered' WHERE dispatch_id = $1`, [d!.id]);
                })).rejects.toThrow(/append-only/);
                await expect(db.transaction(async (manager) => {
                    if (purge) await manager.query(`SET LOCAL app.allow_event_purge = 'on'`);
                    await manager.query(`DELETE FROM order_dispatch_events WHERE dispatch_id = $1`, [d!.id]);
                })).rejects.toThrow(/append-only/);
            }
            expect(await historyOf('dispatch_id = $1', [d!.id])).toEqual([before]);
        });

        it('the service the application uses only appends and reads: it has no way to change or remove an event', () => {
            const methods = Object.getOwnPropertyNames(OrderDispatchEventsService.prototype).filter((name) => name !== 'constructor');
            expect(methods.filter((name) => /update|delete|remove|save|truncate|purge|edit/i.test(name))).toEqual([]);
        });
    });
});
