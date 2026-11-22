// ST-69.2 — The business history of an order is written in the same transaction as the transition (real HTTP + PostgreSQL).
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
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('order/dispatch event history (e2e, ST-69.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let events: OrderDispatchEventsService;
    let apiPrefix: string;
    let token = '';
    let driverId = 0;
    let deliveryTypeId: number;
    const statusIds: Record<string, number> = {};
    const batchIds: number[] = [];
    const tag = Date.now().toString(36).toUpperCase();
    const prefix = `ST692-${tag}`;
    let sequence = 0;

    const patch = (id: number, status: string, requestId?: string) => {
        const call = request(app.getHttpServer()).patch(`/${apiPrefix}/dispatches/${id}/status`).set('Authorization', `Bearer ${token}`);
        if (requestId) call.set('X-Request-Id', requestId);
        return call.send({ status, eventId: uuidv7(), occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.1, accuracy: 8.4 });
    };

    const newDispatch = async () => {
        const n = ++sequence;
        const [{ route_batch_id: batchId }] = await dataSource.query(
            `INSERT INTO route_batches (driver_id, shift_date, status) VALUES ($1, DATE '2041-01-01' + $2::int, 'in_execution') RETURNING route_batch_id`,
            [driverId, n],
        );
        batchIds.push(batchId);
        await dataSource.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, metadata) VALUES ($1, 'route_started', 'system', $2::jsonb)`,
            [batchId, JSON.stringify({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })],
        );
        const ref = `${prefix}-${n}`;
        const [{ dispatch_id: id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref, tracking_code, delivery_address, evidence_policy)
             VALUES ($1, $2, $3, 1, $4, $5, 'Dirección E2E ST-69.2', 'hand_delivery_standard') RETURNING dispatch_id`,
            [deliveryTypeId, statusIds['out_for_delivery'], batchId, ref, `DSP-2041-${String(n).padStart(5, '0')}`],
        );
        return { id: id as number, ref, batchId: batchId as number };
    };

    const history = (ref: string) => dataSource.query(
        `SELECT action, previous_status, new_status, actor_user_id, actor_role, result, correlation_id, dispatch_id, route_batch_id, source_order_ref
           FROM order_dispatch_events WHERE source_order_ref = $1 ORDER BY occurred_at, created_at, order_dispatch_event_id`, [ref]);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);
        events = moduleRef.get(OrderDispatchEventsService);

        const [{ role_id: roleId }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'driver'`);
        const [{ user_id: userId }] = await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
            [roleId, `ST-69.2 driver ${tag}`, `e2e_st692_driver_${tag}`, await hashPassword('E2eTest1234')],
        );
        driverId = userId;
        const login = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_st692_driver_${tag}`, password: 'E2eTest1234' });
        expect(login.status).toBe(200);
        token = login.body.accessToken as string;
        for (const row of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusIds[row.name] = row.dispatch_status_id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            await dataSource.query(`DROP TRIGGER IF EXISTS trg_e2e_st692_fail ON order_dispatch_events`);
            await dataSource.query(`DROP FUNCTION IF EXISTS fn_e2e_st692_fail()`);
            await withEventPurge(dataSource, { dispatchRefs: [`${prefix}%`], routeBatchIds: batchIds, userNames: [`e2e_st692_%_${tag}`] }, async (manager) => {
                await manager.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`${prefix}%`]);
                await manager.query(`DELETE FROM delivery_evidences WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)`, [`${prefix}%`]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${prefix}%`]);
                if (batchIds.length) await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_st692_%_${tag}`]);
            });
        }
        await app?.close();
    });

    it('rebuilds the sequence departure → delivery result from a read, with actor, statuses, link and the request correlation id', async () => {
        const { id, ref, batchId } = await newDispatch();
        expect((await patch(id, 'in_transit', `req-departure-${tag}`)).status).toBe(200);
        await dataSource.query(
            `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url) VALUES ($1, $2, 'signature', 'https://example.test/e2e')`,
            [uuidv7(), id],
        );
        expect((await patch(id, 'delivered', `req-delivered-${tag}`)).status).toBe(200);

        const rows = await history(ref);
        expect(rows).toMatchObject([
            { action: 'dispatch.departed', previous_status: 'out_for_delivery', new_status: 'in_transit', actor_user_id: driverId, actor_role: 'driver', result: 'success', correlation_id: `req-departure-${tag}`, dispatch_id: id, route_batch_id: batchId },
            { action: 'dispatch.delivery_result', previous_status: 'in_transit', new_status: 'delivered', actor_user_id: driverId, actor_role: 'driver', result: 'success', correlation_id: `req-delivered-${tag}`, dispatch_id: id, route_batch_id: batchId },
        ]);
        // A delivery never writes a batch-closing event of its own: the batch link is only the dispatch's.
        expect(rows).toHaveLength(2);

        // Reading it back (by dispatch and by order) twice gives the same thing and mutates nothing.
        const before = await dataSource.query(`SELECT count(*)::int AS n FROM order_dispatch_events WHERE source_order_ref = $1`, [ref]);
        const first = (await events.findByDispatch(id)).map((event) => event.action);
        const second = (await events.findByOrder(ref)).map((event) => event.action);
        expect(first).toEqual(['dispatch.departed', 'dispatch.delivery_result']);
        expect(second).toEqual(first);
        expect(await dataSource.query(`SELECT count(*)::int AS n FROM order_dispatch_events WHERE source_order_ref = $1`, [ref])).toEqual(before);
    });

    it('rolls the whole transition back when the history cannot be written: the command fails and leaves no orphan event', async () => {
        const { id, ref } = await newDispatch();
        await dataSource.query(`
            CREATE OR REPLACE FUNCTION fn_e2e_st692_fail() RETURNS TRIGGER AS $$
            BEGIN RAISE EXCEPTION 'e2e: history write refused'; END; $$ LANGUAGE plpgsql`);
        await dataSource.query(`
            CREATE TRIGGER trg_e2e_st692_fail BEFORE INSERT ON order_dispatch_events
            FOR EACH ROW WHEN (NEW.source_order_ref = '${ref}') EXECUTE FUNCTION fn_e2e_st692_fail()`);
        try {
            const response = await patch(id, 'in_transit');
            expect(response.status).toBe(500);
        } finally {
            await dataSource.query(`DROP TRIGGER IF EXISTS trg_e2e_st692_fail ON order_dispatch_events`);
            await dataSource.query(`DROP FUNCTION IF EXISTS fn_e2e_st692_fail()`);
        }
        const [state] = await dataSource.query(`SELECT ds.name AS status FROM dispatches d JOIN dispatch_statuses ds USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]);
        expect(state.status).toBe('out_for_delivery');
        expect(await history(ref)).toEqual([]);
        expect(await dataSource.query(`SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'status_changed'`, [id])).toEqual([]);
        // The same command goes through once the history is writable again.
        expect((await patch(id, 'in_transit')).status).toBe(200);
        expect(await history(ref)).toHaveLength(1);
    });

    it('keeps the history append-only for the application role: it can read and insert but never update or delete', async () => {
        const { id, ref } = await newDispatch();
        expect((await patch(id, 'in_transit')).status).toBe(200);
        const asApp = async (sql: string, params: unknown[] = []) => dataSource.transaction(async (manager) => {
            await manager.query('SET LOCAL ROLE dispatch_app');
            return manager.query(sql, params);
        });
        expect(await asApp(`SELECT count(*)::int AS n FROM order_dispatch_events WHERE source_order_ref = $1`, [ref])).toEqual([{ n: 1 }]);
        await expect(asApp(`UPDATE order_dispatch_events SET result = 'failed' WHERE source_order_ref = $1`, [ref])).rejects.toThrow();
        await expect(asApp(`DELETE FROM order_dispatch_events WHERE source_order_ref = $1`, [ref])).rejects.toThrow();
        expect(await history(ref)).toHaveLength(1);
    });
});
