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

    describe('TypeOrmExistingDispatchChanges.applyShipmentChange', () => {
        const changes = () => new TypeOrmExistingDispatchChanges(dataSource);
        const PKG_1 = { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 };
        const PKG_2 = { packageId: 'PKG-2', lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1 };

        const insertPackage = async (dispatchId: number, item: typeof PKG_1, conditions: string[] = ['FRAGILE']) => {
            await manager().query(
                `INSERT INTO dispatch_packages
                    (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg, handling_conditions)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [dispatchId, item.packageId, item.lengthCm, item.widthCm, item.heightCm, item.grossWeightKg, conditions],
            );
        };

        /** A dispatch with PKG-1 already stored, like the generator of ST-49.1 leaves it. */
        const withPackage = async (input: { status?: string; routeBatchId?: number | null } = {}) => {
            const dispatch = await insertDispatch(input);
            await insertPackage(dispatch.id, PKG_1);
            return dispatch;
        };

        const packagesOf = async (dispatchId: number) =>
            (await manager().query(
                `SELECT dispatch_package_id AS id, external_package_id AS "packageId",
                        length_cm::float AS length, width_cm::float AS width, height_cm::float AS height,
                        gross_weight_kg::float AS weight, handling_conditions AS conditions
                   FROM dispatch_packages WHERE dispatch_id = $1 ORDER BY external_package_id`,
                [dispatchId],
            )) as {
                id: number;
                packageId: string;
                length: number;
                width: number;
                height: number;
                weight: number;
                conditions: string[];
            }[];

        const change = (salesOrderId: string, blocks: Record<string, unknown>) => ({
            salesOrderId,
            source: 'inventory' as const,
            receivedAt: '2026-10-13T15:00:00Z',
            blocks: blocks as never,
        });

        it('reports that there is no dispatch for an order that has none', async () => {
            await expect(changes().applyShipmentChange(change(ref(), { packages: [PKG_1] }), options())).resolves.toEqual({
                status: 'no_dispatch',
            });
        });

        it('replaces a package of a pending dispatch, keeps the row of the one that did not change and records it', async () => {
            const dispatch = await withPackage({ status: 'pending' });
            await insertPackage(dispatch.id, PKG_2);
            const before = await packagesOf(dispatch.id);

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, {
                    packages: [PKG_1, { ...PKG_2, grossWeightKg: 3.5 }],
                    handlingConditions: ['FRAGILE'],
                }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'pending', changedFields: ['packages'] });
            const after = await packagesOf(dispatch.id);
            expect(after).toHaveLength(2);
            expect(after[0].id).toBe(before[0].id); // PKG-1 did not change: same row
            expect(after[1].id).toBe(before[1].id); // PKG-2 changed its weight in place
            expect(after[1].weight).toBe(3.5);
            const [event] = await eventsOf(dispatch.id);
            expect(event.event_type).toBe('shipment_changed');
            expect(event.metadata.changedBlocks).toEqual(['packages']);
            expect(event.metadata.changes.packages.from).toHaveLength(2);
        });

        it('adds the new packages and deletes the ones Almacén no longer sends', async () => {
            const dispatch = await withPackage({ status: 'pending' });
            await insertPackage(dispatch.id, PKG_2);

            await changes().applyShipmentChange(
                change(dispatch.ref, {
                    packages: [{ packageId: 'PKG-3', lengthCm: 5, widthCm: 5, heightCm: 5, grossWeightKg: 0.5 }],
                    handlingConditions: ['FRAGILE'],
                }),
                options(),
            );

            expect((await packagesOf(dispatch.id)).map((item) => item.packageId)).toEqual(['PKG-3']);
        });

        it('does not write, emit or touch the batch when the message does not differ', async () => {
            const batchId = await insertBatch();
            const dispatch = await withPackage({ status: 'in_planning', routeBatchId: batchId });
            const before = await dispatchRow(dispatch.id);

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, { packages: [PKG_1], handlingConditions: ['FRAGILE'], evidencePolicy: 'hand_delivery_standard' }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: dispatch.id, reason: 'no_change' });
            const after = await dispatchRow(dispatch.id);
            expect(after.route_batch_id).toBe(batchId);
            expect(after.version).toBe(before.version);
            expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
            expect(await eventsOf(dispatch.id)).toEqual([]);
            expect(await batchVersion(batchId)).toBe(0);
        });

        it('does not mistake the extra decimals Almacén sends for a change', async () => {
            const dispatch = await withPackage({ status: 'pending' });

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, {
                    packages: [{ ...PKG_1, lengthCm: 40.001, grossWeightKg: 6.4001 }],
                    handlingConditions: ['FRAGILE'],
                }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: dispatch.id, reason: 'no_change' });
        });

        it('takes an in_planning dispatch out of its batch when its packages change', async () => {
            const batchId = await insertBatch();
            const dispatch = await withPackage({ status: 'in_planning', routeBatchId: batchId });

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, { packages: [{ ...PKG_1, widthCm: 55 }], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toMatchObject({
                status: 'applied',
                statusBefore: 'in_planning',
                statusAfter: 'pending',
                removedFromProposal: true,
            });
            const row = await dispatchRow(dispatch.id);
            expect(row.status).toBe('pending');
            expect(row.route_batch_id).toBeNull();
            expect(row.version).toBe(1);
            expect(await batchVersion(batchId)).toBe(1);
            expect((await packagesOf(dispatch.id))[0].width).toBe(55);
        });

        it('keeps an in_planning dispatch in its batch when only the evidence policy changes', async () => {
            const batchId = await insertBatch();
            const dispatch = await withPackage({ status: 'in_planning', routeBatchId: batchId });

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, { evidencePolicy: 'high_value_control' }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', removedFromProposal: false });
            const row = await dispatchRow(dispatch.id);
            expect(row.evidence_policy).toBe('high_value_control');
            expect(row.route_batch_id).toBe(batchId);
            expect(row.status).toBe('in_planning');
            expect(await batchVersion(batchId)).toBe(0);
        });

        it('applies the handling conditions to every package', async () => {
            const dispatch = await withPackage({ status: 'pending' });
            await insertPackage(dispatch.id, PKG_2);

            await changes().applyShipmentChange(
                change(dispatch.ref, { handlingConditions: ['FRAGILE', 'KEEP_UPRIGHT'] }),
                options(),
            );

            const rows = await packagesOf(dispatch.id);
            expect(rows.map((item) => item.conditions)).toEqual([
                ['FRAGILE', 'KEEP_UPRIGHT'],
                ['FRAGILE', 'KEEP_UPRIGHT'],
            ]);
        });

        it('fills package_ready_at once and never clears it', async () => {
            const dispatch = await withPackage({ status: 'pending' });

            const first = await changes().applyShipmentChange(change(dispatch.ref, { physicallyPacked: true }), options());
            const filled = (await dispatchRow(dispatch.id)).package_ready_at as Date;
            const again = await changes().applyShipmentChange(change(dispatch.ref, { physicallyPacked: true }), options());
            const unpacked = await changes().applyShipmentChange(change(dispatch.ref, { physicallyPacked: false }), options());

            expect(first).toMatchObject({ status: 'applied', changedFields: ['physicallyPacked'] });
            expect(filled).not.toBeNull();
            expect(again).toMatchObject({ status: 'ignored', reason: 'no_change' });
            expect(unpacked).toMatchObject({ status: 'ignored', reason: 'no_change' });
            expect((await dispatchRow(dispatch.id)).package_ready_at).toEqual(filled);
        });

        it.each(['scheduled', 'assigned', 'out_for_delivery', 'delivered'])(
            'leaves a %s dispatch untouched and records what would have changed',
            async (status) => {
                const batchId = await insertBatch();
                const dispatch = await withPackage({ status, routeBatchId: batchId });
                const before = await dispatchRow(dispatch.id);

                const outcome = await changes().applyShipmentChange(
                    change(dispatch.ref, {
                        packages: [{ ...PKG_1, grossWeightKg: 12 }],
                        handlingConditions: ['FRAGILE'],
                        evidencePolicy: 'high_value_control',
                    }),
                    options(),
                );

                expect(outcome).toEqual({
                    status: 'attention_required',
                    dispatchId: dispatch.id,
                    event: {
                        dispatchId: dispatch.id,
                        source: 'inventory',
                        changeType: 'order_changed',
                        receivedAt: '2026-10-13T15:00:00Z',
                    },
                });
                const after = await dispatchRow(dispatch.id);
                expect(after.status).toBe(status);
                expect(after.evidence_policy).toBe(before.evidence_policy);
                expect(after.route_batch_id).toBe(batchId);
                expect((await packagesOf(dispatch.id))[0].weight).toBe(6.4);
                const [event] = await eventsOf(dispatch.id);
                expect(event.event_type).toBe('change_requires_attention');
                expect(event.metadata.changedBlocks).toEqual(['packages', 'evidencePolicy']);
                expect(event.metadata.changes.packages.to[0].grossWeightKg).toBe(12);
                expect(await batchVersion(batchId)).toBe(0);
            },
        );

        it('ignores a cancelled dispatch', async () => {
            const dispatch = await withPackage({ status: 'cancelled' });

            const outcome = await changes().applyShipmentChange(
                change(dispatch.ref, { packages: [{ ...PKG_1, grossWeightKg: 12 }] }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: dispatch.id, reason: 'dispatch_cancelled' });
            expect((await packagesOf(dispatch.id))[0].weight).toBe(6.4);
        });

        it('only touches the delivery dispatch when another type shares the order reference', async () => {
            const shared = ref();
            const delivery = await insertDispatch({ ref: shared, type: 'delivery' });
            await insertPackage(delivery.id, PKG_1);
            const pickup = await insertDispatch({ ref: shared, type: 'supplier_pickup' });
            await insertPackage(pickup.id, PKG_1);

            await changes().applyShipmentChange(
                change(shared, { packages: [{ ...PKG_1, grossWeightKg: 20 }], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect((await packagesOf(delivery.id))[0].weight).toBe(20);
            expect((await packagesOf(pickup.id))[0].weight).toBe(6.4);
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

        it('leaves the packages, the policy and the events unchanged when the transaction fails after a package change', async () => {
            const dispatch = await insertDispatch({ status: 'pending' }, dataSource.manager);
            await dataSource.query(
                `INSERT INTO dispatch_packages
                    (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg, handling_conditions)
                 VALUES ($1, 'PKG-1', 40, 30, 25, 6.4, ARRAY['FRAGILE'])`,
                [dispatch.id],
            );
            try {
                await expect(
                    dataSource.transaction(async (tx) => {
                        const outcome = await new TypeOrmExistingDispatchChanges(dataSource).applyShipmentChange(
                            {
                                salesOrderId: dispatch.ref,
                                source: 'inventory',
                                receivedAt: '2026-10-13T15:00:00Z',
                                blocks: {
                                    packages: [
                                        { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 20 },
                                        { packageId: 'PKG-9', lengthCm: 5, widthCm: 5, heightCm: 5, grossWeightKg: 1 },
                                    ],
                                    handlingConditions: ['FRAGILE'],
                                    evidencePolicy: 'high_value_control',
                                },
                            },
                            { manager: tx },
                        );
                        expect(outcome.status).toBe('applied');
                        throw new Error('business failure after the change');
                    }),
                ).rejects.toThrow('business failure');

                const packages = (await dataSource.query(
                    `SELECT external_package_id, gross_weight_kg::float AS weight
                       FROM dispatch_packages WHERE dispatch_id = $1 ORDER BY external_package_id`,
                    [dispatch.id],
                )) as { external_package_id: string; weight: number }[];
                expect(packages).toEqual([{ external_package_id: 'PKG-1', weight: 6.4 }]);
                const row = await dispatchRow(dispatch.id, dataSource.manager);
                expect(row.evidence_policy).toBe('hand_delivery_standard');
                expect(await eventsOf(dispatch.id, dataSource.manager)).toEqual([]);
            } finally {
                await dataSource.query(`DELETE FROM dispatches WHERE dispatch_id = $1`, [dispatch.id]);
            }
        });
    });
});
