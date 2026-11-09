import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatchStatusPublication } from '../../../../test/helpers/dispatch-status-publication.js';
import { ProcurementPickupRepository } from '../procurement-pickup-intake/repositories/procurement-pickup.repository.js';
import { toReceiptData } from './domain/warehouse-receipt-message.types.js';
import { WarehouseReceiptIntakeService } from './services/warehouse-receipt-intake.service.js';

/**
 * ST-240.3 against PostgreSQL with the delivery-dispatch-db schema loaded (migrations 024 and 025 or later).
 * Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=55432 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run warehouse-receipt.postgres
 *
 * Every test runs inside one transaction that is rolled back, so nothing stays in the database. The real intake
 * service, publication service and outbox (with the checked-in JSON Schemas) run over real SQL; only the two
 * plain insert services (`dispatch_events`, `dispatch_incidents`) are raw-SQL stand-ins, because they are
 * TypeORM-repository wrappers and this spec registers no entities.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');
const RECEIVED_AT = '2026-11-08T12:00:00Z';

describe.skipIf(!PORT)('Warehouse receipt result publication against PostgreSQL (ST-240.3)', () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let counter = 0;

    const manager = (): EntityManager => runner.manager;
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
        ((await manager().query(sql, params)) as T[])[0];

    const intake = () => {
        const dispatchEvents = {
            create: async (data: Record<string, unknown>, options: { manager: EntityManager }) => {
                await options.manager.query(
                    `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_type, reason, metadata, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
                    [data.dispatchId, data.eventType, data.detail, data.actorType, data.reason, JSON.stringify(data.metadata), data.occurredAt],
                );
            },
        };
        const dispatchIncidents = {
            create: async (data: Record<string, unknown>, options: { manager: EntityManager }) => {
                await options.manager.query(
                    `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description, created_at)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [data.id, data.dispatchId, data.incidentReasonId, data.description, data.occurredAt],
                );
            },
        };
        const batchClosing = { closeIfComplete: vi.fn() };
        return new WarehouseReceiptIntakeService(
            dispatchEvents as never, dispatchIncidents as never, createDispatchStatusPublication(dataSource), batchClosing as never,
        );
    };

    /** A supplier pickup built by the real intake (ST-74.1), forced into `picked_up_in_transit` with a tracking code. */
    const createPickup = async (type: 'supplier_pickup' | 'warehouse_return_pickup' = 'supplier_pickup') => {
        const wh = await one<{ code: string }>(`SELECT code FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1`);
        const orderId = `IT-${type === 'supplier_pickup' ? 'PO' : 'RMA'}-${RUN}-${++counter}`;
        await new ProcurementPickupRepository(createDispatchStatusPublication(dataSource)).applyRequested({
            purchaseOrderId: orderId, recordVersion: 1, updatedAt: '2026-11-08T11:00:00Z', approvedAt: '2026-11-08T10:00:00Z',
            supplier: { supplierId: 'SUP-IT', name: 'Proveedor de prueba' },
            contact: { name: 'Contacto', phone: '+59170000000', email: 'pickup-it@example.com' },
            pickupAddress: { line: 'Planta Norte, Calle 5', reference: 'Portón azul', location: { latitude: -16.5, longitude: -68.1 } },
            pickupWindow: { startsAt: '2026-11-20T14:00:00Z', endsAt: '2026-11-20T18:00:00Z' },
            warehouseId: wh.code, products: [{ productId: 'SKU-IT', quantity: 2 }], estimates: { weightKg: 18, volumeM3: 0.5 },
        } as never, { manager: manager() });
        const row = await one<{ id: number; tracking_code: string | null }>(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'picked_up_in_transit'),
                    dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = $2),
                    tracking_code = COALESCE(tracking_code, $3)
              WHERE source_order_ref = $1
          RETURNING dispatch_id AS id, tracking_code`,
            [orderId, type, `DSP-2026-${String(90000 + counter).padStart(5, '0')}`],
        ).then((r) => (Array.isArray(r) ? (r as unknown as { id: number; tracking_code: string | null }[])[0] : r));
        return { id: row.id, orderId, tracking: row.tracking_code! };
    };

    const message = (referenceId: string, referenceType: 'rma' | 'purchase_order', result: 'complete' | 'with_differences' | 'rejected', over: Record<string, unknown> = {}) =>
        toReceiptData({
            receiptId: `RCP-IT-${RUN}-${++counter}`, recordVersion: 1, updatedAt: RECEIVED_AT, receivedAt: RECEIVED_AT,
            warehouseId: 'WH-LPZ-01', referenceType, referenceId, result,
            items: [
                { itemId: 'SKU-LAP-14', expectedQuantity: 10, acceptedQuantity: 8, missingQuantity: 1, damagedQuantity: 1, notes: 'Una caja con golpe' },
                { itemId: 'SKU-MOUSE-02', expectedQuantity: 20, acceptedQuantity: 20 },
            ],
            ...over,
        });

    const outboxOf = async (key: 'purchaseOrderId' | 'salesOrderId', value: string) =>
        (await manager().query(
            `SELECT payload FROM outbound_messages WHERE type = 'dispatch.transfer.status_changed' AND payload->'data'->>'${key}' = $1`,
            [value],
        )) as { payload: { data: Record<string, unknown> } }[];

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
        });
        await dataSource.initialize();
    });

    beforeEach(async () => {
        runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
    });

    afterEach(async () => {
        await runner.rollbackTransaction();
        await runner.release();
    });

    afterAll(async () => {
        await dataSource?.destroy();
    });

    it('a supplier pickup received with differences ends in incident, stores the items and queues the result for Compras', async () => {
        const pickup = await createPickup();
        const data = message(pickup.orderId, 'purchase_order', 'with_differences');

        const result = await intake().apply(data, { manager: manager() });

        expect(result).toMatchObject({ status: 'applied', dispatchId: pickup.id, newStatus: 'incident' });
        const dispatch = await one<{ status: string; closed_at: Date | null }>(
            `SELECT s.name AS status, d.closed_at FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [pickup.id]);
        expect(dispatch).toMatchObject({ status: 'incident', closed_at: null });
        const items = (await manager().query(`SELECT item_code, accepted_quantity::int AS a, missing_quantity::int AS m, damaged_quantity::int AS d, detail FROM warehouse_receipt_items WHERE receipt_id = $1 ORDER BY item_code`, [data.receiptId])) as Record<string, unknown>[];
        expect(items).toEqual([
            { item_code: 'SKU-LAP-14', a: 8, m: 1, d: 1, detail: 'Una caja con golpe' },
            { item_code: 'SKU-MOUSE-02', a: 20, m: 0, d: 0, detail: null },
        ]);
        expect(await one(`SELECT 1 AS ok FROM dispatch_incidents WHERE dispatch_id = $1`, [pickup.id])).toBeTruthy();

        const queued = await outboxOf('purchaseOrderId', pickup.orderId);
        expect(queued).toHaveLength(1);
        expect(queued[0].payload.data).toMatchObject({
            trackingCode: pickup.tracking, status: 'incident', previousStatus: 'picked_up_in_transit', recordVersion: 1,
            result: 'with_differences',
            items: [{ itemCode: 'SKU-LAP-14', acceptedQuantity: 8, missingQuantity: 1, damagedQuantity: 1, detail: 'Una caja con golpe' }],
        });
        // The next publication for this dispatch continues the sequence instead of repeating version 1.
        const event = await one<{ metadata: { outboundRecordVersion: number } }>(
            `SELECT metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'status_changed'`, [pickup.id]);
        expect(event.metadata.outboundRecordVersion).toBe(1);
    });

    it('a complete supplier pickup is delivered and closed, with the result and no items', async () => {
        const pickup = await createPickup();

        await intake().apply(message(pickup.orderId, 'purchase_order', 'complete', { items: [{ itemId: 'SKU-1', expectedQuantity: 5, acceptedQuantity: 5 }] }), { manager: manager() });

        const dispatch = await one<{ status: string; closed_at: Date | null }>(
            `SELECT s.name AS status, d.closed_at FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [pickup.id]);
        expect(dispatch.status).toBe('delivered');
        expect(dispatch.closed_at).not.toBeNull();
        const [queued] = await outboxOf('purchaseOrderId', pickup.orderId);
        expect(queued.payload.data).toMatchObject({ status: 'delivered', result: 'complete' });
        expect(queued.payload.data).not.toHaveProperty('items');
    });

    it('an RMA that ends in incident is queued for Inventarios; a complete one is not queued', async () => {
        const rejected = await createPickup('warehouse_return_pickup');
        await intake().apply(message(rejected.orderId, 'rma', 'rejected'), { manager: manager() });
        const [queued] = await outboxOf('salesOrderId', rejected.orderId);
        expect(queued.payload.data).toMatchObject({ status: 'incident', result: 'rejected' });

        const complete = await createPickup('warehouse_return_pickup');
        await intake().apply(message(complete.orderId, 'rma', 'complete'), { manager: manager() });
        expect(await outboxOf('salesOrderId', complete.orderId)).toHaveLength(0);
        const status = await one<{ status: string }>(`SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [complete.id]);
        expect(status.status).toBe('returned_to_warehouse');
    });

    it('a resent receipt (same recordVersion) changes nothing and queues nothing more', async () => {
        const pickup = await createPickup();
        const data = message(pickup.orderId, 'purchase_order', 'with_differences');
        const service = intake();

        await service.apply(data, { manager: manager() });
        const again = await service.apply(data, { manager: manager() });

        expect(again).toEqual({ status: 'ignored' });
        expect(await outboxOf('purchaseOrderId', pickup.orderId)).toHaveLength(1);
        expect(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM dispatch_incidents WHERE dispatch_id = $1`, [pickup.id])).n)).toBe(1);
    });
});
