import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PendingSalesOrder } from './entities/pending-sales-order.entity.js';
import { TypeOrmConsolidationRecord } from './repositories/typeorm-consolidation-record.js';
import { TypeOrmExistingDispatchChanges } from './repositories/typeorm-existing-dispatch-changes.js';
import { TypeOrmPendingSalesOrderStore } from './repositories/typeorm-pending-sales-order.store.js';

/**
 * Against a real PostgreSQL with the delivery-dispatch-db schema loaded **including migrations 013
 * and 014**. Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5433 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run sales-order-intake.integration
 *
 * Every test runs inside a transaction that is rolled back, so nothing is left behind (and the
 * append-only `dispatch_events` never needs a purge). The only test that commits on purpose is the
 * rollback one, and it removes its own rows.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');

describe.skipIf(!PORT)('sales-order intake against PostgreSQL', () => {
    let dataSource: DataSource;
    let runner: QueryRunner;
    let counter = 0;

    const ref = (): string => `it-${RUN}-${++counter}`;
    const manager = (): EntityManager => runner.manager;
    const options = () => ({ manager: manager() });

    const insertBatch = async (em: EntityManager = manager()): Promise<number> => {
        const [row] = await em.query(
            `INSERT INTO route_batches (status, shift_date) VALUES ('provisional', CURRENT_DATE) RETURNING route_batch_id AS id`,
        );
        return row.id as number;
    };

    const insertZone = async (): Promise<number> => {
        const [row] = await manager().query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min, boundary)
             VALUES ($1, $2, 30, polygon '((-68.20,-16.60),(-68.00,-16.60),(-68.00,-16.40),(-68.20,-16.40))')
             RETURNING delivery_zone_id AS id`,
            [`IT${RUN}${counter}`.slice(0, 20), `IT zone ${RUN} ${counter}`],
        );
        return row.id as number;
    };

    const insertDispatch = async (
        input: { ref?: string; status?: string; routeBatchId?: number | null; type?: string } = {},
        em: EntityManager = manager(),
    ): Promise<{ id: number; ref: string }> => {
        const orderRef = input.ref ?? ref();
        const [row] = await em.query(
            `INSERT INTO dispatches (
                dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, delivery_reference,
                delivery_latitude, delivery_longitude, contact_name, contact_phone, contact_email, route_batch_id
             ) VALUES (
                (SELECT dispatch_type_id FROM dispatch_types WHERE name = $1),
                (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                $3, 'Av. Arce 2345', 'Edificio azul', -16.5412, -68.0731,
                'María López', '+59170000000', 'maria@example.com', $4
             ) RETURNING dispatch_id AS id`,
            [input.type ?? 'delivery', input.status ?? 'pending', orderRef, input.routeBatchId ?? null],
        );
        return { id: row.id as number, ref: orderRef };
    };

    const dispatchRow = async (id: number, em: EntityManager = manager()) => {
        const [row] = await em.query(
            `SELECT d.*, s.name AS status FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1`,
            [id],
        );
        return row;
    };

    const eventsOf = async (id: number, em: EntityManager = manager()) =>
        (await em.query(
            `SELECT event_type, actor_type, metadata FROM dispatch_events WHERE dispatch_id = $1 ORDER BY dispatch_event_id`,
            [id],
        )) as { event_type: string; actor_type: string; metadata: Record<string, any> }[];

    const batchVersion = async (id: number): Promise<number> =>
        (await manager().query(`SELECT version FROM route_batches WHERE route_batch_id = $1`, [id]))[0].version;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
            entities: [PendingSalesOrder],
        });
        await dataSource.initialize();
    });

    beforeEach(async () => {
        runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
    });

    afterEach(async () => {
        if (runner?.isTransactionActive) await runner.rollbackTransaction();
        if (runner && !runner.isReleased) await runner.release();
    });

    afterAll(async () => {
        // If the connection never opened (wrong credentials), destroying it would hide the real error.
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    describe('TypeOrmPendingSalesOrderStore', () => {
        const store = () => new TypeOrmPendingSalesOrderStore(dataSource);

        it('returns null for an order that was never stored', async () => {
            await expect(store().find(ref(), options())).resolves.toBeNull();
        });

        it('stores and reads the blocks with the version as a number', async () => {
            const order = ref();
            const blocks = {
                confirmedAt: '2026-10-11T13:58:00Z',
                recipient: { name: 'María López', phone: '+59170000000' },
                deliveryAddress: { line: 'Av. Arce', location: { latitude: -16.5, longitude: -68.1 } },
            };

            await store().save({ salesOrderId: order, recordVersion: 3, blocks }, options());
            const found = await store().find(order, options());

            expect(found).toEqual({ salesOrderId: order, recordVersion: 3, blocks });
            expect(typeof found!.recordVersion).toBe('number');
        });

        it('replaces the blocks but never lowers the stored version', async () => {
            const order = ref();
            await store().save({ salesOrderId: order, recordVersion: 5, blocks: { priority: 'urgent' } }, options());

            await store().save({ salesOrderId: order, recordVersion: 2, blocks: { priority: 'normal' } }, options());

            const found = await store().find(order, options());
            expect(found?.recordVersion).toBe(5);
            expect(found?.blocks).toEqual({ priority: 'normal' });
        });
    });

    describe('TypeOrmConsolidationRecord', () => {
        const record = () => new TypeOrmConsolidationRecord(dataSource);

        const insertPending = async (order: string) => {
            await manager().query(
                `INSERT INTO pending_sales_orders (sales_order_id, record_version, payload) VALUES ($1, 1, '{}'::jsonb)`,
                [order],
            );
            await manager().query(
                `INSERT INTO pending_shipments (sales_order_id, record_version, payload) VALUES ($1, 1, '{}'::jsonb)`,
                [order],
            );
        };

        it('says an order was not consolidated until it is marked', async () => {
            const order = ref();
            await insertPending(order);

            await expect(record().find(order, options())).resolves.toBeNull();
        });

        it('marks the rows of both sources and reads the mark back', async () => {
            const dispatch = await insertDispatch();
            await insertPending(dispatch.ref);
            const consolidatedAt = new Date('2026-10-12T14:00:00.000Z');

            await record().mark(dispatch.ref, { dispatchId: dispatch.id, consolidatedAt }, options());

            await expect(record().find(dispatch.ref, options())).resolves.toEqual({
                dispatchId: dispatch.id,
                consolidatedAt,
            });
            const [shipment] = await manager().query(
                `SELECT dispatch_id, consolidated_at FROM pending_shipments WHERE sales_order_id = $1`,
                [dispatch.ref],
            );
            expect(shipment.dispatch_id).toBe(dispatch.id);
            expect(new Date(shipment.consolidated_at)).toEqual(consolidatedAt);
        });

        it('refuses to mark an order with a dispatch that does not exist (foreign key)', async () => {
            const order = ref();
            await insertPending(order);
            await manager().query('SAVEPOINT before_mark');

            await expect(
                record().mark(order, { dispatchId: 2147483000, consolidatedAt: new Date() }, options()),
            ).rejects.toThrow();
            await manager().query('ROLLBACK TO SAVEPOINT before_mark');
        });
    });

    describe('TypeOrmExistingDispatchChanges', () => {
        const changes = () => new TypeOrmExistingDispatchChanges(dataSource);
        const change = (salesOrderId: string, blocks: Record<string, unknown>) => ({
            salesOrderId,
            source: 'marketplace' as const,
            receivedAt: '2026-10-12T15:00:00Z',
            blocks: blocks as never,
        });

        it('reports that there is no dispatch for an order that has none', async () => {
            await expect(changes().applyDeliveryChange(change(ref(), { priority: 'urgent' }), options())).resolves.toEqual({
                status: 'no_dispatch',
            });
        });

        it('updates the contact of a pending dispatch and records the change with its before and after', async () => {
            const dispatch = await insertDispatch({ status: 'pending' });

            const outcome = await changes().applyDeliveryChange(
                change(dispatch.ref, { recipient: { name: 'María López', phone: '+59179999999' } }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusBefore: 'pending', statusAfter: 'pending' });
            const row = await dispatchRow(dispatch.id);
            expect(row.contact_phone).toBe('+59179999999');
            expect(row.contact_email).toBeNull();
            const [event] = await eventsOf(dispatch.id);
            expect(event.event_type).toBe('order_changed');
            expect(event.actor_type).toBe('system');
            expect(event.metadata.changes.contactPhone).toEqual({ from: '+59170000000', to: '+59179999999' });
        });

        it('takes an in_planning dispatch out of its batch, finds its zone and raises both versions', async () => {
            const zoneId = await insertZone();
            const batchId = await insertBatch();
            const dispatch = await insertDispatch({ status: 'in_planning', routeBatchId: batchId });
            const batchBefore = await batchVersion(batchId);

            const outcome = await changes().applyDeliveryChange(
                change(dispatch.ref, {
                    deliveryAddress: { line: 'Calle 21 de Calacoto', location: { latitude: -16.5, longitude: -68.1 } },
                }),
                options(),
            );

            expect(outcome).toMatchObject({
                status: 'applied',
                statusBefore: 'in_planning',
                statusAfter: 'pending',
                removedFromProposal: true,
            });
            const row = await dispatchRow(dispatch.id);
            expect(row.route_batch_id).toBeNull();
            expect(row.sequence_order).toBeNull();
            expect(row.version).toBe(1);
            expect(row.delivery_zone_id).toBe(zoneId);
            expect(row.delivery_address).toBe('Calle 21 de Calacoto');
            expect(row.delivery_reference).toBeNull();
            expect(await batchVersion(batchId)).toBe(batchBefore + 1);
        });

        it('sends a dispatch to address_review when its new address is outside every zone', async () => {
            await insertZone();
            const dispatch = await insertDispatch({ status: 'pending' });

            const outcome = await changes().applyDeliveryChange(
                change(dispatch.ref, {
                    deliveryAddress: { line: 'Lejos', location: { latitude: 10, longitude: 10 } },
                }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'address_review' });
            const row = await dispatchRow(dispatch.id);
            expect(row.status).toBe('address_review');
            expect(row.delivery_zone_id).toBeNull();
        });

        it('brings an address_review dispatch back to pending when the new address has a zone', async () => {
            await insertZone();
            const dispatch = await insertDispatch({ status: 'address_review' });

            const outcome = await changes().applyDeliveryChange(
                change(dispatch.ref, {
                    deliveryAddress: { line: 'Av. Arce 2345', location: { latitude: -16.5, longitude: -68.1 } },
                }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusBefore: 'address_review', statusAfter: 'pending' });
        });

        it('leaves a scheduled dispatch untouched, records the detail and returns the event', async () => {
            const batchId = await insertBatch();
            const dispatch = await insertDispatch({ status: 'scheduled', routeBatchId: batchId });
            const before = await dispatchRow(dispatch.id);

            const outcome = await changes().applyDeliveryChange(
                change(dispatch.ref, { deliveryAddress: { line: 'Otra calle' } }),
                options(),
            );

            expect(outcome).toEqual({
                status: 'attention_required',
                dispatchId: dispatch.id,
                event: {
                    dispatchId: dispatch.id,
                    source: 'marketplace',
                    changeType: 'order_changed',
                    receivedAt: '2026-10-12T15:00:00Z',
                },
            });
            const after = await dispatchRow(dispatch.id);
            expect(after.delivery_address).toBe(before.delivery_address);
            expect(after.route_batch_id).toBe(batchId);
            expect(after.version).toBe(before.version);
            const [event] = await eventsOf(dispatch.id);
            expect(event.event_type).toBe('change_requires_attention');
            expect(event.metadata.changedBlocks).toEqual(['deliveryAddress']);
        });

        it('cancels a pending dispatch and records the status change', async () => {
            const dispatch = await insertDispatch({ status: 'pending' });

            const outcome = await changes().cancel(
                { salesOrderId: dispatch.ref, source: 'marketplace', cancelledAt: '2026-10-12T15:59:00Z' },
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'cancelled' });
            expect((await dispatchRow(dispatch.id)).status).toBe('cancelled');
            const [event] = await eventsOf(dispatch.id);
            expect(event).toMatchObject({ event_type: 'status_changed' });
            expect(event.metadata).toMatchObject({ from: 'pending', to: 'cancelled' });
        });

        it('cancels an in_planning dispatch and leaves its batch', async () => {
            const batchId = await insertBatch();
            const dispatch = await insertDispatch({ status: 'in_planning', routeBatchId: batchId });

            await changes().cancel(
                { salesOrderId: dispatch.ref, source: 'inventory', cancelledAt: '2026-10-12T15:59:00Z' },
                options(),
            );

            const row = await dispatchRow(dispatch.id);
            expect(row.status).toBe('cancelled');
            expect(row.route_batch_id).toBeNull();
            expect(await batchVersion(batchId)).toBe(1);
        });

        it('does not cancel an assigned dispatch', async () => {
            const dispatch = await insertDispatch({ status: 'assigned' });

            const outcome = await changes().cancel(
                { salesOrderId: dispatch.ref, source: 'marketplace', cancelledAt: '2026-10-12T15:59:00Z' },
                options(),
            );

            expect(outcome).toMatchObject({
                status: 'attention_required',
                event: { changeType: 'order_cancelled' },
            });
            expect((await dispatchRow(dispatch.id)).status).toBe('assigned');
        });

        it('marks a dispatch as not ready and ready again', async () => {
            const dispatch = await insertDispatch({ status: 'pending' });
            const input = (ready: boolean) => ({
                salesOrderId: dispatch.ref,
                source: 'inventory' as const,
                ready,
                receivedAt: '2026-10-12T16:00:00Z',
            });

            await changes().setShipmentReady(input(false), options());
            expect((await dispatchRow(dispatch.id)).shipment_ready).toBe(false);

            await changes().setShipmentReady(input(true), options());
            expect((await dispatchRow(dispatch.id)).shipment_ready).toBe(true);
            const events = await eventsOf(dispatch.id);
            expect(events.map((event) => event.event_type)).toEqual([
                'shipment_readiness_changed',
                'shipment_readiness_changed',
            ]);
        });

        it('only touches the delivery dispatch when another type shares the order reference', async () => {
            const shared = ref();
            const delivery = await insertDispatch({ ref: shared, type: 'delivery' });
            const pickup = await insertDispatch({ ref: shared, type: 'supplier_pickup' });

            await changes().applyDeliveryChange(
                change(shared, { recipient: { name: 'Otra Persona', phone: '+59171111111' } }),
                options(),
            );

            expect((await dispatchRow(delivery.id)).contact_name).toBe('Otra Persona');
            expect((await dispatchRow(pickup.id)).contact_name).toBe('María López');
        });
    });

    describe('rollback', () => {
        it('leaves the dispatch and its events unchanged when the transaction fails after the change', async () => {
            // Committed on purpose, outside the per-test transaction; removed at the end of the test.
            const dispatch = await insertDispatch({ status: 'pending' }, dataSource.manager);
            try {
                await expect(
                    dataSource.transaction(async (tx) => {
                        await new TypeOrmExistingDispatchChanges(dataSource).applyDeliveryChange(
                            {
                                salesOrderId: dispatch.ref,
                                source: 'marketplace',
                                receivedAt: '2026-10-12T15:00:00Z',
                                blocks: { recipient: { name: 'Cambio', phone: '+59179999999' } },
                            },
                            { manager: tx },
                        );
                        throw new Error('business failure after the change');
                    }),
                ).rejects.toThrow('business failure');

                const row = await dispatchRow(dispatch.id, dataSource.manager);
                expect(row.contact_name).toBe('María López');
                expect(row.contact_phone).toBe('+59170000000');
                expect(await eventsOf(dispatch.id, dataSource.manager)).toEqual([]);
            } finally {
                await dataSource.query(`DELETE FROM dispatches WHERE dispatch_id = $1`, [dispatch.id]);
            }
        });
    });
});
