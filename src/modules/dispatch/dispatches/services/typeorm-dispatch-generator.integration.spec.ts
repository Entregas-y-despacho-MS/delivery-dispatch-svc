import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import type { ConsolidatedOrder } from '../../../messaging/sales-order-intake/domain/consolidated-order.types.js';
import { OrderDispatchEventEntity } from '../../../audit/order-dispatch-events/entities/order-dispatch-event.entity.js';
import { OrderDispatchEventsService } from '../../../audit/order-dispatch-events/services/order-dispatch-events.service.js';
import { TypeOrmDispatchGenerator } from './typeorm-dispatch-generator.service.js';

// Run only against a disposable database loaded from delivery-dispatch-db/db-output.sql.
// Example: ST49_INTEGRATION_DB=1 DB_NAME=<disposable-db> npm run test -- <this file>
describe.skipIf(process.env.ST49_INTEGRATION_DB !== '1')('TypeOrmDispatchGenerator with PostgreSQL', () => {
    let dataSource: DataSource;
    const generator = new TypeOrmDispatchGenerator(new OrderDispatchEventsService(undefined as never));

    const order = (salesOrderId: string, location = true): ConsolidatedOrder => ({
        salesOrderId,
        confirmedAt: '2026-10-12T14:00:00.000Z',
        recipient: { name: 'Ana Pérez', phone: '+59170000000' },
        deliveryAddress: {
            line: 'Av. Arce 2345', reference: 'Edificio azul',
            ...(location && { location: { latitude: -16.5412, longitude: -68.0731 } }),
        },
        priority: 'normal',
        warehouseId: 'WH-LPZ-01',
        packages: [{ packageId: 'PK-1', lengthCm: 10, widthCm: 20, heightCm: 30, grossWeightKg: 2.5 }],
        handlingConditions: ['fragile'],
        evidencePolicy: 'hand_delivery_standard',
        physicallyPacked: false,
    });

    beforeAll(async () => {
        if (!process.env.DB_NAME?.startsWith('codex_')) {
            throw new Error('ST49_INTEGRATION_DB requires a disposable DB_NAME starting with codex_.');
        }
        dataSource = new DataSource({
            type: 'postgres', host: process.env.DB_HOST ?? '127.0.0.1',
            port: Number(process.env.DB_PORT ?? 5432),
            username: process.env.DB_USER, password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            entities: [OrderDispatchEventEntity],
        });
        await dataSource.initialize();
        await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min, boundary)
             VALUES ('ST49-TEST', 'ST-49.1 test zone', 30, $1::polygon)`,
            ['((-69,-17),(-67,-17),(-67,-16),(-69,-16))'],
        );
    });

    afterAll(async () => { if (dataSource?.isInitialized) await dataSource.destroy(); });

    it('persists zone, packages, D0, unique tracking codes and an address review without scheduling', async () => {
        const first = await dataSource.transaction((manager) =>
            generator.createFromConsolidated(order('ST49-SO-1'), { manager }));
        const second = await dataSource.transaction((manager) =>
            generator.createFromConsolidated(order('ST49-SO-2', false), { manager }));

        const rows = await dataSource.query(
            `SELECT d.dispatch_id, d.source_order_ref, d.tracking_code, s.name AS status,
                    d.delivery_zone_id, d.order_confirmed_at, d.origin_warehouse_id,
                    d.scheduled_window_start, d.scheduled_window_end, d.tracking_token,
                    d.delivery_reference, d.payment_status_label
             FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
             WHERE d.dispatch_id IN ($1, $2) ORDER BY d.dispatch_id`,
            [first.dispatchId, second.dispatchId],
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((row: { status: string }) => row.status)).toEqual(['pending', 'address_review']);
        expect(rows[0].delivery_zone_id).not.toBeNull();
        expect(rows[1].delivery_zone_id).toBeNull();
        expect(rows[0].order_confirmed_at.toISOString()).toBe('2026-10-12T14:00:00.000Z');
        expect(rows[0].origin_warehouse_id).not.toBeNull();
        expect(rows[0].delivery_reference).toBe('Edificio azul');
        expect(rows[0].payment_status_label).toBe('paid');
        expect(rows.every((row: Record<string, unknown>) =>
            row.scheduled_window_start === null && row.scheduled_window_end === null && row.tracking_token === null,
        )).toBe(true);
        expect(rows[0].tracking_code).toMatch(/^DSP-\d{4}-\d{5}$/);
        expect(rows[1].tracking_code).toMatch(/^DSP-\d{4}-\d{5}$/);
        expect(rows[0].tracking_code).not.toBe(rows[1].tracking_code);

        const packages = await dataSource.query(
            'SELECT external_package_id, handling_conditions FROM dispatch_packages WHERE dispatch_id = $1',
            [first.dispatchId],
        );
        expect(packages).toEqual([{ external_package_id: 'PK-1', handling_conditions: ['fragile'] }]);

        // ST-69.2: each creation left its history event in the same transaction, with the status it was created in.
        const history = await dataSource.query(
            `SELECT source_order_ref, dispatch_id, action, previous_status, new_status, actor_role, result
               FROM order_dispatch_events WHERE source_order_ref IN ('ST49-SO-1', 'ST49-SO-2') ORDER BY dispatch_id`,
        );
        expect(history).toEqual([
            { source_order_ref: 'ST49-SO-1', dispatch_id: first.dispatchId, action: 'dispatch.created', previous_status: null, new_status: 'pending', actor_role: 'system', result: 'success' },
            { source_order_ref: 'ST49-SO-2', dispatch_id: second.dispatchId, action: 'dispatch.created', previous_status: null, new_status: 'address_review', actor_role: 'system', result: 'success' },
        ]);

        await expect(dataSource.transaction((manager) =>
            generator.createFromConsolidated(order('ST49-SO-1'), { manager }))).rejects.toMatchObject({ code: '23505' });
    });
});
