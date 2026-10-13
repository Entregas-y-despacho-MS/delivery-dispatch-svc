import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatchGenerator } from '../sales-order-intake/ports/dispatch-generator.port.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { MessageBus } from '../../../plugins/messaging/message-bus.port.js';
import type { MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { generateMessageId } from '../../../plugins/messaging/envelope/uuid-v7.js';

/**
 * End-to-end intake check against a disposable PostgreSQL loaded from delivery-dispatch-db/db-output.sql.
 * Run with APP_INTEGRATION_DB=1, MESSAGING_ADAPTER=memory, and DB_NAME starting with `codex_`.
 */
describe.skipIf(process.env.APP_INTEGRATION_DB !== '1')('shipment intake through AppModule with PostgreSQL', () => {
    let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
    let bus: MemoryMessageBusAdapter;
    let dataSource: DataSource;
    const runId = randomBytes(5).toString('hex');
    const now = '2026-10-12T20:00:00.000Z';

    const envelope = (type: string, source: MessageEnvelope['source'], data: Record<string, unknown>): MessageEnvelope => ({
        messageId: generateMessageId(),
        type,
        schemaVersion: 1,
        source,
        occurredAt: now,
        data,
    });

    const marketplace = (salesOrderId: string): MessageEnvelope => envelope(
        'marketplace.sales_order.confirmed',
        'marketplace',
        {
            salesOrderId,
            recordVersion: 1,
            updatedAt: now,
            confirmedAt: now,
            recipient: { name: 'Prueba ST-72.1', phone: '+59170000000' },
            deliveryAddress: { line: 'Calle de prueba 123' },
        },
    );

    const inventory = (salesOrderId: string): MessageEnvelope => envelope(
        'inventory.shipment.ready',
        'inventory',
        {
            salesOrderId,
            recordVersion: 1,
            updatedAt: now,
            warehouseId: 'WH-LPZ-01',
            packages: [{
                packageId: `PK-${salesOrderId}`,
                lengthCm: 10,
                widthCm: 20,
                heightCm: 30,
                grossWeightKg: 2.5,
            }],
            physicallyPacked: false,
        },
    );

    const deliveryDispatches = async (salesOrderId: string) => await dataSource.query(
        `SELECT dispatch_id FROM dispatches
          WHERE source_order_ref = $1
            AND dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery')`,
        [salesOrderId],
    ) as { dispatch_id: number }[];

    const expectConsolidated = async (salesOrderId: string) => {
        const dispatches = await deliveryDispatches(salesOrderId);
        expect(dispatches).toHaveLength(1);

        const [state] = await dataSource.query(
            `SELECT pso.dispatch_id AS marketplace_dispatch_id, ps.dispatch_id AS inventory_dispatch_id,
                    pso.consolidated_at AS marketplace_consolidated_at,
                    ps.consolidated_at AS inventory_consolidated_at
               FROM pending_sales_orders pso
               JOIN pending_shipments ps USING (sales_order_id)
              WHERE pso.sales_order_id = $1`,
            [salesOrderId],
        );
        expect(Number(state.marketplace_dispatch_id)).toBe(Number(dispatches[0].dispatch_id));
        expect(Number(state.inventory_dispatch_id)).toBe(Number(dispatches[0].dispatch_id));
        expect(state.marketplace_consolidated_at).toBeTruthy();
        expect(state.inventory_consolidated_at).toBeTruthy();

        const packages = await dataSource.query(
            'SELECT 1 FROM dispatch_packages WHERE dispatch_id = $1 AND external_package_id = $2',
            [dispatches[0].dispatch_id, `PK-${salesOrderId}`],
        );
        expect(packages).toHaveLength(1);
    };

    beforeAll(async () => {
        if (!process.env.DB_NAME?.startsWith('codex_')) {
            throw new Error('APP_INTEGRATION_DB requires a disposable DB_NAME starting with codex_.');
        }
        if (!['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
            throw new Error('APP_INTEGRATION_DB may connect only to a local PostgreSQL host.');
        }
        if (process.env.MESSAGING_ADAPTER !== 'memory') {
            throw new Error('APP_INTEGRATION_DB requires MESSAGING_ADAPTER=memory.');
        }

        const { AppModule } = await import('../../../app.module.js');
        app = await NestFactory.createApplicationContext(AppModule, { logger: false });
        bus = app.get(MessageBus) as MemoryMessageBusAdapter;
        dataSource = app.get(DataSource);
    });

    afterAll(async () => {
        if (app) await app.close();
    });

    it('boots the real modules and consolidates Marketplace before Almacén exactly once', async () => {
        const salesOrderId = `IT-${runId}-MF`;
        const marketMessage = marketplace(salesOrderId);
        await bus.publish(marketMessage.type, marketMessage);
        expect(await deliveryDispatches(salesOrderId)).toHaveLength(0);

        const inventoryMessage = inventory(salesOrderId);
        await bus.publish(inventoryMessage.type, inventoryMessage);
        await expectConsolidated(salesOrderId);

        const receipts = await dataSource.query(
            'SELECT status FROM inbound_messages WHERE message_id = ANY($1::uuid[])',
            [[marketMessage.messageId, inventoryMessage.messageId]],
        );
        expect(receipts).toHaveLength(2);
        expect(receipts.every((row: { status: string }) => row.status === 'processed')).toBe(true);
    });

    it('consolidates Almacén before Marketplace exactly once', async () => {
        const salesOrderId = `IT-${runId}-IF`;
        const inventoryMessage = inventory(salesOrderId);
        await bus.publish(inventoryMessage.type, inventoryMessage);
        expect(await deliveryDispatches(salesOrderId)).toHaveLength(0);

        const marketMessage = marketplace(salesOrderId);
        await bus.publish(marketMessage.type, marketMessage);
        await expectConsolidated(salesOrderId);
    });

    it('rolls back Almacén state and its receipt when the dispatch generator fails', async () => {
        const salesOrderId = `IT-${runId}-RB`;
        const marketMessage = marketplace(salesOrderId);
        await bus.publish(marketMessage.type, marketMessage);

        const generator = app.get(DispatchGenerator);
        const originalGenerate = generator.createFromConsolidated.bind(generator);
        const priorErrors = bus.handlerErrors.length;
        generator.createFromConsolidated = async () => { throw new Error('intentional generator failure'); };
        const inventoryMessage = inventory(salesOrderId);
        try {
            await bus.publish(inventoryMessage.type, inventoryMessage);
        } finally {
            generator.createFromConsolidated = originalGenerate;
        }

        expect(bus.handlerErrors.length).toBe(priorErrors + 1);
        expect(await dataSource.query('SELECT 1 FROM inbound_messages WHERE message_id = $1', [inventoryMessage.messageId]))
            .toHaveLength(0);
        expect(await dataSource.query('SELECT 1 FROM pending_shipments WHERE sales_order_id = $1', [salesOrderId]))
            .toHaveLength(0);
        expect(await dataSource.query(
            "SELECT 1 FROM sales_order_sync_states WHERE sales_order_id = $1 AND source = 'inventory'",
            [salesOrderId],
        )).toHaveLength(0);
        expect(await deliveryDispatches(salesOrderId)).toHaveLength(0);
    });
    it('applies a later package change of Almacén to the dispatch, once, and only alerts after the promise (ST-72.5)', async () => {
        const salesOrderId = `IT-${runId}-PK`;
        const marketMessage = marketplace(salesOrderId);
        await bus.publish(marketMessage.type, marketMessage);
        const inventoryMessage = inventory(salesOrderId);
        await bus.publish(inventoryMessage.type, inventoryMessage);
        await expectConsolidated(salesOrderId);
        const [{ dispatch_id: dispatchId }] = await deliveryDispatches(salesOrderId);

        const weightOf = async (): Promise<number> => {
            const [row] = await dataSource.query(
                'SELECT gross_weight_kg::float AS weight FROM dispatch_packages WHERE dispatch_id = $1 AND external_package_id = $2',
                [dispatchId, `PK-${salesOrderId}`],
            );
            return row.weight;
        };
        const eventsOf = async (type: string): Promise<number> => (
            await dataSource.query('SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2', [dispatchId, type])
        ).length;
        const updated = (recordVersion: number, grossWeightKg: number) => envelope(
            'inventory.shipment.updated',
            'inventory',
            {
                salesOrderId,
                recordVersion,
                updatedAt: now,
                isReady: true,
                packages: [{ packageId: `PK-${salesOrderId}`, lengthCm: 10, widthCm: 20, heightCm: 30, grossWeightKg }],
            },
        );

        // A heavier package arrives while the dispatch is still editable: it reaches dispatch_packages.
        expect(await weightOf()).toBe(2.5);
        const heavier = updated(2, 7.5);
        await bus.publish(heavier.type, heavier);
        expect(await weightOf()).toBe(7.5);
        expect(await eventsOf('shipment_changed')).toBe(1);

        // The same packages again, in a newer version: nothing differs, nothing is written or recorded.
        const again = updated(3, 7.5);
        await bus.publish(again.type, again);
        expect(await eventsOf('shipment_changed')).toBe(1);

        // Past the promise the dispatch is not modified; the coordinator is told through its events.
        await dataSource.query(
            `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'scheduled')
              WHERE dispatch_id = $1`,
            [dispatchId],
        );
        const lighter = updated(4, 1.5);
        await bus.publish(lighter.type, lighter);
        expect(await weightOf()).toBe(7.5);
        expect(await eventsOf('change_requires_attention')).toBe(1);
        expect(await eventsOf('shipment_changed')).toBe(1);
    });
});
