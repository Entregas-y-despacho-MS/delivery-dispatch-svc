import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import { TypeOrmExistingDispatchChanges } from './typeorm-existing-dispatch-changes.js';

const ORDER = 'SO-2026-000123';

/** A row of the SELECT ... FOR UPDATE, as `pg` returns it (NUMERIC comes as a string). */
const row = (overrides: Record<string, unknown> = {}) => ({
    dispatch_id: 7,
    status: 'pending',
    route_batch_id: null,
    contact_name: 'María López',
    contact_phone: '+59170000000',
    contact_email: 'maria@example.com',
    delivery_address: 'Av. Arce 2345',
    delivery_reference: 'Edificio azul',
    delivery_latitude: '-16.541200',
    delivery_longitude: '-68.073100',
    delivery_zone_id: 1,
    priority: 'normal',
    shipment_ready: true,
    ...overrides,
});

const packageRow = (overrides: Record<string, unknown> = {}) => ({
    external_package_id: 'PKG-1',
    length_cm: '40.00',
    width_cm: '30.00',
    height_cm: '25.00',
    gross_weight_kg: '6.400',
    handling_conditions: ['FRAGILE'],
    ...overrides,
});

describe('TypeOrmExistingDispatchChanges', () => {
    let calls: { sql: string; params: unknown[] }[];
    /** Every statement in the order it ran, locks included (`calls` leaves the batch reads out). */
    let trace: string[];
    let dispatchRow: Record<string, unknown> | null;
    let zoneRow: { id: number } | null;
    let headerRow: { evidence_policy: string; package_ready_at: Date | null; warehouse_code: string | null };
    let warehouseRow: { id: number } | null;
    let packageRows: Record<string, unknown>[];
    let changes: TypeOrmExistingDispatchChanges;
    const options = () => ({ manager: manager as never });

    const manager = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
            const isPeek = sql.includes('SELECT d.route_batch_id, s.name AS status');
            const isBatchLock = sql.includes('FROM route_batches WHERE route_batch_id = $1 FOR UPDATE');
            trace.push(
                isPeek ? 'peek' : isBatchLock ? `lock batch ${params[0]}` : sql.includes('FOR UPDATE OF d') ? 'lock dispatch' : 'other',
            );
            // The unlocked read of the batch and its lock are not part of what the operations write.
            if (isPeek) return dispatchRow ? [{ route_batch_id: dispatchRow.route_batch_id, status: dispatchRow.status }] : [];
            if (isBatchLock) return [];
            calls.push({ sql, params });
            if (sql.includes('FOR UPDATE OF d')) return dispatchRow ? [dispatchRow] : [];
            if (sql.includes('FROM delivery_zones')) return zoneRow ? [zoneRow] : [];
            if (sql.includes('w.code AS warehouse_code')) return [headerRow];
            if (sql.includes('FROM warehouses WHERE code')) return warehouseRow ? [warehouseRow] : [];
            if (sql.includes('FROM dispatch_packages WHERE dispatch_id')) return packageRows;
            return [];
        }),
    };

    const sqlOf = (fragment: string) => calls.find((call) => call.sql.includes(fragment));

    beforeEach(() => {
        calls = [];
        trace = [];
        dispatchRow = row();
        zoneRow = { id: 3 };
        headerRow = { evidence_policy: 'hand_delivery_standard', package_ready_at: null, warehouse_code: 'WH-LPZ-01' };
        warehouseRow = { id: 2 };
        packageRows = [packageRow()];
        manager.query.mockClear();
        changes = new TypeOrmExistingDispatchChanges({ manager } as never);
    });

    describe('applyDeliveryChange', () => {
        const input = (blocks: Record<string, unknown>) => ({
            salesOrderId: ORDER,
            source: 'marketplace' as const,
            receivedAt: '2026-10-12T15:00:00Z',
            blocks: blocks as never,
        });

        it('does nothing when the order is not a dispatch yet', async () => {
            dispatchRow = null;

            const outcome = await changes.applyDeliveryChange(input({ priority: 'urgent' }), options());

            expect(outcome).toEqual({ status: 'no_dispatch' });
            expect(calls).toHaveLength(1);
        });

        it('locks the delivery dispatch of the order', async () => {
            await changes.applyDeliveryChange(input({ priority: 'urgent' }), options());

            const select = calls[0];
            expect(select.sql).toContain('FOR UPDATE OF d');
            expect(select.sql).toContain(`name = 'delivery'`);
            expect(select.params).toEqual([ORDER]);
        });

        it('updates the contact of a pending dispatch and records the change with its before and after', async () => {
            const outcome = await changes.applyDeliveryChange(
                input({ recipient: { name: 'María López', phone: '+59179999999', email: 'maria@example.com' } }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', dispatchId: 7, statusBefore: 'pending', statusAfter: 'pending' });
            const update = sqlOf('UPDATE dispatches SET');
            expect(update?.sql).toContain('contact_phone = $2');
            expect(update?.sql).toContain('updated_at = NOW()');
            expect(update?.params).toEqual([7, '+59179999999']);
            const event = JSON.parse(sqlOf('INSERT INTO dispatch_events')!.params[2] as string);
            expect(event.changes).toEqual({ contactPhone: { from: '+59170000000', to: '+59179999999' } });
            expect(event.source).toBe('marketplace');
        });

        it('looks the zone up again when the address changes and keeps the status when it has one', async () => {
            const outcome = await changes.applyDeliveryChange(
                input({ deliveryAddress: { line: 'Calle 21', location: { latitude: -16.54, longitude: -68.08 } } }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'pending' });
            expect(sqlOf('FROM delivery_zones')?.params).toEqual([-68.08, -16.54]);
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('delivery_zone_id =');
            expect(update.params).toContain(3);
        });

        it('sends the dispatch to address_review when the new address is outside every zone', async () => {
            zoneRow = null;

            const outcome = await changes.applyDeliveryChange(
                input({ deliveryAddress: { line: 'Lejos', location: { latitude: -10, longitude: -60 } } }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'address_review' });
            expect(sqlOf('UPDATE dispatches SET')?.params).toContain('address_review');
        });

        it('does not look a zone up when the new address has no usable location', async () => {
            const outcome = await changes.applyDeliveryChange(
                input({ deliveryAddress: { line: 'Av. Arce 2345', reference: 'Edificio azul' } }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'address_review' });
            expect(sqlOf('FROM delivery_zones')).toBeUndefined();
        });

        it('takes an in_planning dispatch out of its batch and raises both versions', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.applyDeliveryChange(
                input({ recipient: { name: 'María López', phone: '+59179999999', email: 'maria@example.com' } }),
                options(),
            );

            expect(outcome).toMatchObject({
                status: 'applied',
                statusBefore: 'in_planning',
                statusAfter: 'pending',
                removedFromProposal: true,
            });
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('route_batch_id = NULL');
            expect(update.sql).toContain('sequence_order = NULL');
            expect(update.sql).toContain('version = version + 1');
            expect(sqlOf('UPDATE route_batches SET version')?.params).toEqual([4]);
        });

        it('does not write when nothing of the dispatch changes', async () => {
            const outcome = await changes.applyDeliveryChange(
                input({ preferences: { contactless: true } }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
            expect(sqlOf('INSERT INTO dispatch_events')).toBeUndefined();
        });

        it('leaves a scheduled dispatch untouched, records the detail and returns the event to emit', async () => {
            dispatchRow = row({ status: 'scheduled', route_batch_id: 4 });

            const outcome = await changes.applyDeliveryChange(
                input({ deliveryAddress: { line: 'Otra calle' } }),
                options(),
            );

            expect(outcome).toEqual({
                status: 'attention_required',
                dispatchId: 7,
                event: {
                    dispatchId: 7,
                    source: 'marketplace',
                    changeType: 'order_changed',
                    receivedAt: '2026-10-12T15:00:00Z',
                },
            });
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
            expect(sqlOf('UPDATE route_batches')).toBeUndefined();
            const insert = sqlOf('INSERT INTO dispatch_events')!;
            expect(insert.params[1]).toBe('change_requires_attention');
            expect(JSON.parse(insert.params[2] as string).changedBlocks).toEqual(['deliveryAddress']);
        });

        it('ignores a change for a cancelled dispatch', async () => {
            dispatchRow = row({ status: 'cancelled' });

            const outcome = await changes.applyDeliveryChange(input({ priority: 'urgent' }), options());

            expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'dispatch_cancelled' });
            expect(calls).toHaveLength(1);
        });

        it('runs on the manager it receives, not on the default one', async () => {
            const dataSourceQuery = vi.fn().mockResolvedValue([]);
            const other = new TypeOrmExistingDispatchChanges({ manager: { query: dataSourceQuery } } as never);

            await other.applyDeliveryChange(input({ priority: 'urgent' }), options());

            expect(dataSourceQuery).not.toHaveBeenCalled();
            expect(manager.query).toHaveBeenCalled();
        });
    });

    describe('cancel', () => {
        const input = { salesOrderId: ORDER, source: 'marketplace' as const, cancelledAt: '2026-10-12T15:59:00Z', reason: 'Cliente' };

        it('does nothing when the order is not a dispatch yet', async () => {
            dispatchRow = null;

            await expect(changes.cancel(input, options())).resolves.toEqual({ status: 'no_dispatch' });
        });

        it('cancels a pending dispatch and records the status change', async () => {
            const outcome = await changes.cancel(input, options());

            expect(outcome).toMatchObject({ status: 'applied', statusBefore: 'pending', statusAfter: 'cancelled' });
            expect(sqlOf('UPDATE dispatches SET')?.sql).toContain(`WHERE name = 'cancelled'`);
            const insert = sqlOf('INSERT INTO dispatch_events')!;
            expect(insert.params[1]).toBe('status_changed');
            expect(JSON.parse(insert.params[2] as string)).toMatchObject({ from: 'pending', to: 'cancelled', source: 'marketplace' });
        });

        it('takes an in_planning dispatch out of its batch when it cancels it', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.cancel(input, options());

            expect(outcome).toMatchObject({ status: 'applied', removedFromProposal: true });
            expect(sqlOf('UPDATE route_batches SET version')?.params).toEqual([4]);
        });

        it('does not cancel an assigned dispatch: it asks for attention with the cancellation', async () => {
            dispatchRow = row({ status: 'assigned', route_batch_id: 4 });

            const outcome = await changes.cancel(input, options());

            expect(outcome).toMatchObject({
                status: 'attention_required',
                event: { dispatchId: 7, source: 'marketplace', changeType: 'order_cancelled', receivedAt: '2026-10-12T15:59:00Z' },
            });
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
        });

        it('is a no-op for a dispatch that is already cancelled', async () => {
            dispatchRow = row({ status: 'cancelled' });

            await expect(changes.cancel(input, options())).resolves.toEqual({
                status: 'ignored',
                dispatchId: 7,
                reason: 'dispatch_cancelled',
            });
        });
    });

    describe('setShipmentReady', () => {
        const input = (ready: boolean) => ({
            salesOrderId: ORDER,
            source: 'inventory' as const,
            ready,
            receivedAt: '2026-10-12T16:00:00Z',
        });

        it('marks a pending dispatch as not ready', async () => {
            const outcome = await changes.setShipmentReady(input(false), options());

            expect(outcome).toMatchObject({ status: 'applied', changedFields: ['shipment_ready'] });
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('shipment_ready = $2');
            expect(update.params[1]).toBe(false);
        });

        it('takes an in_planning dispatch out of the proposal and returns it to pending', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.setShipmentReady(input(false), options());

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'pending', removedFromProposal: true });
            expect(sqlOf('UPDATE route_batches SET version')?.params).toEqual([4]);
        });

        it('does nothing when the dispatch already has that readiness', async () => {
            await expect(changes.setShipmentReady(input(true), options())).resolves.toEqual({
                status: 'ignored',
                dispatchId: 7,
                reason: 'no_change',
            });
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
        });

        it('asks for attention when a scheduled dispatch stops being ready', async () => {
            dispatchRow = row({ status: 'scheduled' });

            const outcome = await changes.setShipmentReady(input(false), options());

            expect(outcome).toMatchObject({ status: 'attention_required', event: { changeType: 'order_changed', source: 'inventory' } });
        });
    });

    describe('applyShipmentChange', () => {
        const PKG_1 = { packageId: 'PKG-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 };
        const PKG_2 = { packageId: 'PKG-2', lengthCm: 10, widthCm: 10, heightCm: 10, grossWeightKg: 1 };
        const input = (blocks: Record<string, unknown>) => ({
            salesOrderId: ORDER,
            source: 'inventory' as const,
            receivedAt: '2026-10-13T15:00:00Z',
            blocks: blocks as never,
        });

        it('does nothing when the order is not a dispatch yet', async () => {
            dispatchRow = null;

            await expect(changes.applyShipmentChange(input({ packages: [PKG_1] }), options())).resolves.toEqual({
                status: 'no_dispatch',
            });
            expect(calls).toHaveLength(1);
        });

        it('writes nothing when the message does not differ from the dispatch', async () => {
            const outcome = await changes.applyShipmentChange(
                input({ packages: [PKG_1], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
            expect(sqlOf('DELETE FROM dispatch_packages')).toBeUndefined();
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
            expect(sqlOf('INSERT INTO dispatch_events')).toBeUndefined();
        });

        it('upserts each package by external id and deletes the ones that are no longer sent', async () => {
            const outcome = await changes.applyShipmentChange(
                input({ packages: [{ ...PKG_1, grossWeightKg: 9 }, PKG_2], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', changedFields: ['packages'] });
            const inserts = calls.filter((call) => call.sql.includes('INSERT INTO dispatch_packages'));
            expect(inserts).toHaveLength(2);
            expect(inserts[0].sql).toContain('ON CONFLICT (dispatch_id, external_package_id) DO UPDATE');
            expect(inserts[0].params).toEqual([7, 'PKG-1', 40, 30, 25, 9, ['FRAGILE']]);
            expect(inserts[1].params).toEqual([7, 'PKG-2', 10, 10, 10, 1, ['FRAGILE']]);
            const del = sqlOf('DELETE FROM dispatch_packages')!;
            expect(del.params).toEqual([7, ['PKG-1', 'PKG-2']]);
        });

        it('reads the numeric columns as numbers before comparing', async () => {
            packageRows = [packageRow({ gross_weight_kg: '6.400', length_cm: '40.00' })];

            const outcome = await changes.applyShipmentChange(
                input({ packages: [{ ...PKG_1, lengthCm: 40.001, grossWeightKg: 6.4001 }], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
        });

        it('takes an in_planning dispatch out of its batch, raises both versions and records the change', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.applyShipmentChange(
                input({ packages: [{ ...PKG_1, widthCm: 50 }], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toMatchObject({
                status: 'applied',
                statusBefore: 'in_planning',
                statusAfter: 'pending',
                removedFromProposal: true,
            });
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('route_batch_id = NULL');
            expect(update.sql).toContain('version = version + 1');
            expect(update.params).toContain('pending');
            expect(sqlOf('UPDATE route_batches SET version')?.params).toEqual([4]);
            const insert = sqlOf('INSERT INTO dispatch_events')!;
            expect(insert.params[1]).toBe('shipment_changed');
            expect(JSON.parse(insert.params[2] as string).removedFromProposal).toBe(true);
        });

        it('keeps an in_planning dispatch in its batch when only the evidence policy changes', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.applyShipmentChange(input({ evidencePolicy: 'high_value_control' }), options());

            expect(outcome).toMatchObject({ status: 'applied', removedFromProposal: false, changedFields: ['evidencePolicy'] });
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('evidence_policy = $2');
            expect(update.sql).not.toContain('route_batch_id = NULL');
            expect(update.params).toEqual([7, 'high_value_control']);
            expect(sqlOf('UPDATE route_batches')).toBeUndefined();
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
        });

        it('fills package_ready_at when the shipment is physically packed', async () => {
            const outcome = await changes.applyShipmentChange(input({ physicallyPacked: true }), options());

            expect(outcome).toMatchObject({ status: 'applied', changedFields: ['physicallyPacked'] });
            expect(sqlOf('UPDATE dispatches SET')?.sql).toContain('package_ready_at = NOW()');
        });

        it('does not fill package_ready_at again when the dispatch already has it', async () => {
            headerRow = {
                evidence_policy: 'hand_delivery_standard',
                package_ready_at: new Date('2026-10-12T10:00:00Z'),
                warehouse_code: 'WH-LPZ-01',
            };

            const outcome = await changes.applyShipmentChange(input({ physicallyPacked: true }), options());

            expect(outcome).toEqual({ status: 'ignored', dispatchId: 7, reason: 'no_change' });
        });

        it('leaves a scheduled dispatch untouched and records what would have changed', async () => {
            dispatchRow = row({ status: 'scheduled', route_batch_id: 4 });

            const outcome = await changes.applyShipmentChange(
                input({ packages: [{ ...PKG_1, grossWeightKg: 9 }], handlingConditions: ['FRAGILE'] }),
                options(),
            );

            expect(outcome).toEqual({
                status: 'attention_required',
                dispatchId: 7,
                event: {
                    dispatchId: 7,
                    source: 'inventory',
                    changeType: 'order_changed',
                    receivedAt: '2026-10-13T15:00:00Z',
                },
            });
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
            expect(sqlOf('DELETE FROM dispatch_packages')).toBeUndefined();
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
            expect(sqlOf('UPDATE route_batches')).toBeUndefined();
            const insert = sqlOf('INSERT INTO dispatch_events')!;
            expect(insert.params[1]).toBe('change_requires_attention');
            const metadata = JSON.parse(insert.params[2] as string);
            expect(metadata.changedBlocks).toEqual(['packages']);
            expect(metadata.changes.packages.to[0].grossWeightKg).toBe(9);
        });

        it('updates the origin warehouse after resolving its code, before writing anything', async () => {
            const outcome = await changes.applyShipmentChange(
                input({ warehouseId: 'WH-LPZ-02' }),
                options(),
            );

            expect(outcome).toMatchObject({ status: 'applied', changedFields: ['warehouseId'] });
            const lookup = sqlOf('FROM warehouses WHERE code')!;
            expect(lookup.sql).toContain('active = TRUE');
            expect(lookup.params).toEqual(['WH-LPZ-02']);
            const update = sqlOf('UPDATE dispatches SET')!;
            expect(update.sql).toContain('origin_warehouse_id = $2');
            expect(update.params).toEqual([7, 2]);
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
            const event = JSON.parse(sqlOf('INSERT INTO dispatch_events')!.params[2] as string);
            expect(event.changes.warehouseId).toEqual({ from: 'WH-LPZ-01', to: 'WH-LPZ-02' });
        });

        it('takes an in_planning dispatch out of its batch when the warehouse changes', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            const outcome = await changes.applyShipmentChange(input({ warehouseId: 'WH-LPZ-02' }), options());

            expect(outcome).toMatchObject({ status: 'applied', statusAfter: 'pending', removedFromProposal: true });
            expect(sqlOf('UPDATE route_batches SET version')?.params).toEqual([4]);
        });

        it('rejects the message, without writing, when the warehouse code is unknown or inactive', async () => {
            warehouseRow = null;

            await expect(
                changes.applyShipmentChange(input({ packages: [PKG_2], warehouseId: 'WH-XXX' }), options()),
            ).rejects.toBeInstanceOf(RejectedMessageException);
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
            expect(sqlOf('INSERT INTO dispatch_events')).toBeUndefined();
        });

        it('does not look the warehouse up when the dispatch is past the promise', async () => {
            dispatchRow = row({ status: 'scheduled', route_batch_id: 4 });

            const outcome = await changes.applyShipmentChange(input({ warehouseId: 'WH-LPZ-02' }), options());

            expect(outcome).toMatchObject({ status: 'attention_required' });
            expect(sqlOf('FROM warehouses WHERE code')).toBeUndefined();
            expect(sqlOf('UPDATE dispatches')).toBeUndefined();
        });

        it('does nothing for the same warehouse code', async () => {
            await expect(changes.applyShipmentChange(input({ warehouseId: 'WH-LPZ-01' }), options())).resolves.toEqual({
                status: 'ignored',
                dispatchId: 7,
                reason: 'no_change',
            });
            expect(sqlOf('FROM warehouses WHERE code')).toBeUndefined();
        });

        it('ignores a cancelled dispatch', async () => {
            dispatchRow = row({ status: 'cancelled' });

            await expect(changes.applyShipmentChange(input({ packages: [PKG_2] }), options())).resolves.toEqual({
                status: 'ignored',
                dispatchId: 7,
                reason: 'dispatch_cancelled',
            });
            expect(sqlOf('INSERT INTO dispatch_packages')).toBeUndefined();
        });
    });

    // Lock order of planning: batch first, then the order (the cutoff, the 1st approval and the generator do
    // the same). The opposite order made this transaction and the cutoff wait on each other (deadlock).
    describe('lock order', () => {
        const cancelInput = { salesOrderId: ORDER, source: 'marketplace' as const, cancelledAt: '2026-10-12T15:59:00Z', reason: 'Cliente' };
        const deliveryInput = {
            salesOrderId: ORDER,
            source: 'marketplace' as const,
            receivedAt: '2026-10-12T15:00:00Z',
            blocks: { priority: 'urgent' } as never,
        };

        it('locks the batch before the order when an in_planning order is in a batch', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 4 });

            await changes.cancel(cancelInput, options());

            expect(trace.slice(0, 3)).toEqual(['peek', 'lock batch 4', 'lock dispatch']);
        });

        it('keeps that order in every operation that can take the order out of its batch', async () => {
            dispatchRow = row({ status: 'in_planning', route_batch_id: 9 });

            await changes.applyDeliveryChange(deliveryInput, options());
            const afterDelivery = [...trace];
            trace = [];
            await changes.setShipmentReady(
                { salesOrderId: ORDER, source: 'warehouse' as const, receivedAt: '2026-10-12T15:00:00Z', shipmentReady: false } as never,
                options(),
            );

            expect(afterDelivery.indexOf('lock batch 9')).toBeLessThan(afterDelivery.indexOf('lock dispatch'));
            expect(trace.indexOf('lock batch 9')).toBeGreaterThanOrEqual(0);
            expect(trace.indexOf('lock batch 9')).toBeLessThan(trace.indexOf('lock dispatch'));
        });

        it('does not lock a batch for an order that never leaves it (pending, scheduled, no batch)', async () => {
            for (const over of [
                { status: 'pending', route_batch_id: null },
                { status: 'scheduled', route_batch_id: 4 },
                { status: 'in_planning', route_batch_id: null },
            ]) {
                trace = [];
                dispatchRow = row(over);

                await changes.cancel(cancelInput, options());

                expect(trace.some((step) => step.startsWith('lock batch'))).toBe(false);
            }
        });

        it('does nothing else when the order does not exist', async () => {
            dispatchRow = null;

            await changes.cancel(cancelInput, options());

            expect(trace).toEqual(['peek', 'lock dispatch']);
        });

        it('also locks the batch the order moved to while it waited for its lock', async () => {
            // Read as batch 4, but by the time the order is locked it is in batch 5.
            dispatchRow = row({ status: 'in_planning', route_batch_id: 5 });
            const original = manager.query.getMockImplementation()!;
            manager.query.mockImplementationOnce(async () => {
                trace.push('peek');
                return [{ route_batch_id: 4, status: 'in_planning' }];
            });

            await changes.cancel(cancelInput, options());
            manager.query.mockImplementation(original);

            expect(trace.slice(0, 4)).toEqual(['peek', 'lock batch 4', 'lock dispatch', 'lock batch 5']);
        });
    });
});
