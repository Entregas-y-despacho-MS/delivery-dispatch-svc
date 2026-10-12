import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('TypeOrmExistingDispatchChanges', () => {
    let calls: { sql: string; params: unknown[] }[];
    let dispatchRow: Record<string, unknown> | null;
    let zoneRow: { id: number } | null;
    let changes: TypeOrmExistingDispatchChanges;
    const options = () => ({ manager: manager as never });

    const manager = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            if (sql.includes('FOR UPDATE OF d')) return dispatchRow ? [dispatchRow] : [];
            if (sql.includes('FROM delivery_zones')) return zoneRow ? [zoneRow] : [];
            return [];
        }),
    };

    const sqlOf = (fragment: string) => calls.find((call) => call.sql.includes(fragment));

    beforeEach(() => {
        calls = [];
        dispatchRow = row();
        zoneRow = { id: 3 };
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
});
