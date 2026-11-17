import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { InventoryReceiptConfirmedData } from '../domain/warehouse-receipt-message.types.js';
import { WarehouseReceiptIntakeService } from './warehouse-receipt-intake.service.js';

const data: InventoryReceiptConfirmedData = {
    receiptId: 'RCPT-1',
    referenceType: 'rma',
    referenceId: 'RMA-1',
    result: 'complete',
    receivedAt: '2026-11-08T12:00:00Z',
    recordVersion: 1,
};

const UPDATED_AT = new Date('2026-11-08T12:00:01Z');

const foundDispatch = {
    dispatch_id: 55,
    status: 'picked_up_in_transit',
    version: 3,
    route_batch_id: null,
    tracking_code: 'DSP-2026-00055',
};

function build() {
    const dispatchEvents = { create: vi.fn() };
    const dispatchIncidents = { create: vi.fn() };
    const statusPublication = { publish: vi.fn().mockResolvedValue(1) };
    const batchClosing = { closeIfComplete: vi.fn() };
    const service = new WarehouseReceiptIntakeService(
        dispatchEvents as any, dispatchIncidents as any, statusPublication as any, batchClosing as any,
    );
    return { service, dispatchEvents, dispatchIncidents, statusPublication, batchClosing };
}

describe('WarehouseReceiptIntakeService.apply', () => {
    it('ignores a repeated or out-of-order recordVersion before resolving anything', async () => {
        const { service } = build();
        const query = vi.fn().mockResolvedValueOnce([{ record_version: 2 }]);

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ status: 'ignored' });
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('ignores an exact repeat: the same recordVersion already saved for that receiptId', async () => {
        const { service } = build();
        const query = vi.fn().mockResolvedValueOnce([{ record_version: data.recordVersion }]);

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ status: 'ignored' });
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('resolves the dispatch deterministically (ORDER BY ... LIMIT 1), never relying on an unordered FOR UPDATE', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]);

        await service.apply(data, { manager: { query } as unknown as EntityManager });

        const resolve = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM dispatches'));
        expect(resolve[0]).toMatch(/ORDER BY d\.dispatch_id\s+LIMIT 1/);
    });

    it('never degrades an already-applied receipt to orphan on a correction: dispatch link and status stay untouched', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([{ record_version: 1, status: 'applied', dispatch_id: 55 }]) // existing: already applied
            .mockResolvedValueOnce([]) // UPDATE warehouse_receipts (informational)
            .mockResolvedValueOnce([]); // DELETE items

        const result = await service.apply(
            { ...data, recordVersion: 2, notes: 'Corrección: faltaba 1 caja', result: 'complete' },
            { manager: { query } as unknown as EntityManager },
        );

        expect(result).toEqual({ status: 'correction', dispatchId: 55 });
        expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE dispatches'), expect.anything());
        expect(query).not.toHaveBeenCalledWith(expect.stringContaining('FROM dispatches'), expect.anything());
        const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE warehouse_receipts'));
        expect(update[1]).toEqual(['RCPT-1', 2, 'Corrección: faltaba 1 caja', 'complete', new Date(data.receivedAt)]);
    });

    it('replaces the items of an already-applied receipt on a correction, delete before insert', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([{ record_version: 1, status: 'applied', dispatch_id: 55 }])
            .mockResolvedValueOnce([]) // UPDATE warehouse_receipts
            .mockResolvedValueOnce([]) // DELETE items
            .mockResolvedValueOnce([]) // INSERT item 1
            .mockResolvedValueOnce([]); // INSERT item 2

        await service.apply({
            ...data, recordVersion: 2, result: 'with_differences',
            items: [
                { packageId: 10, acceptedQuantity: 1, missingQuantity: 0, damagedQuantity: 0 },
                { itemCode: 'SKU-1', acceptedQuantity: 2, missingQuantity: 1, damagedQuantity: 0 },
            ],
        }, { manager: { query } as unknown as EntityManager });

        const calls = query.mock.calls;
        const deleteIndex = calls.findIndex(([sql]: [string]) => sql.includes('DELETE FROM warehouse_receipt_items'));
        const insertIndexes = calls
            .map(([sql]: [string], i: number) => (sql.includes('INSERT INTO warehouse_receipt_items') ? i : -1))
            .filter((i: number) => i !== -1);

        expect(calls[deleteIndex][1]).toEqual(['RCPT-1']);
        expect(insertIndexes).toHaveLength(2);
        expect(insertIndexes.every((i: number) => i > deleteIndex)).toBe(true);
        expect(calls[insertIndexes[0]][1]).toEqual(['RCPT-1', 10, null, 1, 0, 0, null]);
        expect(calls[insertIndexes[1]][1]).toEqual(['RCPT-1', null, 'SKU-1', 2, 1, 0, null]);
    });

    it('a correction with no items just deletes the old ones, without inserting anything', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([{ record_version: 1, status: 'applied', dispatch_id: 55 }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        await service.apply({ ...data, recordVersion: 2, items: undefined }, { manager: { query } as unknown as EntityManager });

        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[2][0]).toContain('DELETE FROM warehouse_receipt_items');
    });

    it('marks the receipt orphan when the reference matches no dispatch', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([]) // idempotency: nothing yet
            .mockResolvedValueOnce([]) // resolve: not found
            .mockResolvedValue([]); // saveReceipt (insert + delete items)

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ status: 'orphan', dispatchId: null, referenceId: 'RMA-1' });
        const insert = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO warehouse_receipts'));
        expect(insert[1]).toEqual(['RCPT-1', null, 'rma', 'RMA-1', 'complete', new Date(data.receivedAt), 1, null, 'orphan']);
    });

    it('marks the receipt orphan when the resolved dispatch is not picked_up_in_transit', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ ...foundDispatch, status: 'in_transit' }])
            .mockResolvedValue([]);

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toEqual({ status: 'orphan', dispatchId: 55, referenceId: 'RMA-1' });
    });

    it('marks the receipt orphan when trackingCode is given and does not match the resolved dispatch', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValue([]);

        const result = await service.apply(
            { ...data, trackingCode: 'DSP-2026-99999' },
            { manager: { query } as unknown as EntityManager },
        );

        expect(result).toEqual({ status: 'orphan', dispatchId: 55, referenceId: 'RMA-1' });
    });

    it('closes a complete RMA pickup as returned_to_warehouse, with no outbound message', async () => {
        const { service, dispatchEvents, statusPublication, batchClosing } = build();
        statusPublication.publish.mockResolvedValue(null); // returned_to_warehouse is not a published outcome
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([]) // insert receipt
            .mockResolvedValueOnce([]) // delete items
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]); // UPDATE dispatches

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toMatchObject({ status: 'applied', dispatchId: 55, newStatus: 'returned_to_warehouse' });
        const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches'));
        expect(update[1]).toEqual([55, 'returned_to_warehouse', true, new Date(data.receivedAt)]);
        expect(result).toMatchObject({ events: { statusChanged: { dispatchId: 55, status: 'returned_to_warehouse', previousStatus: 'picked_up_in_transit', version: 4, updatedAt: '2026-11-08T12:00:01.000Z' } } });
        expect((result as any).events.incidentReported).toBeUndefined();
        expect(dispatchEvents.create.mock.calls[0][0].metadata).not.toHaveProperty('outboundRecordVersion');
        expect(dispatchEvents.create).toHaveBeenCalledWith(
            expect.objectContaining({ dispatchId: 55, detail: 'picked_up_in_transit -> returned_to_warehouse' }),
            { manager: expect.anything() },
        );
        expect(batchClosing.closeIfComplete).not.toHaveBeenCalled();
    });

    it('does not affect the receipt when the batch cannot close yet', async () => {
        const { service, batchClosing } = build();
        const withBatch = { ...foundDispatch, route_batch_id: 7 };
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([withBatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]);
        batchClosing.closeIfComplete.mockResolvedValue(false);

        const result = await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(result).toMatchObject({ status: 'applied', dispatchId: 55, newStatus: 'returned_to_warehouse' });
        expect(batchClosing.closeIfComplete).toHaveBeenCalledWith(expect.anything(), 7, {
            dispatchId: 55, dispatchStatus: 'returned_to_warehouse', cause: 'warehouse_receipt_confirmed',
        });
    });

    it('never calls closeIfComplete when the dispatch has no batch', async () => {
        const { service, batchClosing } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch]) // route_batch_id: null
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]);

        await service.apply(data, { manager: { query } as unknown as EntityManager });

        expect(batchClosing.closeIfComplete).not.toHaveBeenCalled();
    });

    it('closes a complete supplier pickup as delivered, publishing the transfer update to Compras', async () => {
        const { service, statusPublication, batchClosing } = build();
        const withBatch = { ...foundDispatch, route_batch_id: 900 };
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([withBatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]);

        const result = await service.apply(
            { ...data, referenceType: 'purchase_order', referenceId: 'PO-1' },
            { manager: { query } as unknown as EntityManager },
        );

        expect(result).toMatchObject({ status: 'applied', dispatchId: 55, newStatus: 'delivered' });
        expect(statusPublication.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            dispatchId: 55, status: 'delivered', previousStatus: 'picked_up_in_transit',
        }));
        expect(batchClosing.closeIfComplete).toHaveBeenCalledWith(expect.anything(), 900, expect.objectContaining({ dispatchId: 55 }));
    });

    it('opens an incident for with_differences, without closing the dispatch', async () => {
        const { service, dispatchIncidents } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1]) // UPDATE dispatches
            .mockResolvedValueOnce([{ incident_reason_id: 6, criticality: 'high' }]); // incident_reasons lookup

        const result = await service.apply(
            { ...data, result: 'with_differences', notes: 'Falta una caja' },
            { manager: { query } as unknown as EntityManager },
        );

        expect(result).toMatchObject({ status: 'applied', dispatchId: 55, newStatus: 'incident' });
        const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE dispatches'));
        expect(update[1][1]).toBe('incident');
        expect(update[1][2]).toBe(false); // does not close the dispatch
        expect(dispatchIncidents.create).toHaveBeenCalledWith(expect.objectContaining({
            dispatchId: 55, incidentReasonId: 6, description: 'Falta una caja',
        }), expect.anything());
    });

    it('publishes the incident status to Compras for a supplier pickup (contract allows it, reportedStatus enum)', async () => {
        const { service, statusPublication } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1])
            .mockResolvedValueOnce([{ incident_reason_id: 6, criticality: 'high' }]);

        await service.apply(
            { ...data, referenceType: 'purchase_order', referenceId: 'PO-1', result: 'rejected' },
            { manager: { query } as unknown as EntityManager },
        );

        expect(statusPublication.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            dispatchId: 55, status: 'incident', previousStatus: 'picked_up_in_transit',
        }));
    });

    it('opens an incident for rejected the same way as with_differences', async () => {
        const { service, dispatchIncidents } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1])
            .mockResolvedValueOnce([{ incident_reason_id: 6, criticality: 'high' }]);

        const result = await service.apply({ ...data, result: 'rejected' }, { manager: { query } as unknown as EntityManager });

        expect(result).toMatchObject({ status: 'applied', dispatchId: 55, newStatus: 'incident' });
        expect(dispatchIncidents.create).toHaveBeenCalledOnce();
    });

    it('throws if the INC-RECEIPT-DIFF incident reason is missing from the catalog', async () => {
        const { service } = build();
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1])
            .mockResolvedValueOnce([]); // incident_reasons lookup: not found

        await expect(service.apply({ ...data, result: 'rejected' }, { manager: { query } as unknown as EntityManager }))
            .rejects.toThrow('INC-RECEIPT-DIFF');
    });

    const diffItems = [
        { itemCode: 'SKU-1', acceptedQuantity: 8, missingQuantity: 2, damagedQuantity: 0, detail: 'Faltan 2' },
        { itemCode: 'SKU-2', acceptedQuantity: 5, missingQuantity: 0, damagedQuantity: 0 },
    ];

    function incidentQuery(itemInserts = 0) {
        const query = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([foundDispatch])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        for (let i = 0; i < itemInserts; i++) query.mockResolvedValueOnce([]);
        return query
            .mockResolvedValueOnce([[{ version: 4, updated_at: UPDATED_AT }], 1])
            .mockResolvedValueOnce([{ incident_reason_id: 6, criticality: 'high' }]);
    }

    it('hands the receipt result and its items to the publication, in the same transaction manager', async () => {
        const { service, statusPublication } = build();
        const manager = { query: incidentQuery(diffItems.length) } as unknown as EntityManager;

        await service.apply(
            { ...data, referenceType: 'purchase_order', referenceId: 'PO-1', result: 'with_differences', items: diffItems as never },
            { manager },
        );

        expect(statusPublication.publish).toHaveBeenCalledWith(manager, {
            dispatchId: 55, status: 'incident', previousStatus: 'picked_up_in_transit',
            occurredAt: new Date(data.receivedAt),
            receipt: { result: 'with_differences', items: diffItems },
        });
    });

    it('publishes an RMA that ends in incident too (Inventarios), not only supplier pickups', async () => {
        const { service, statusPublication } = build();

        await service.apply({ ...data, result: 'rejected' }, { manager: { query: incidentQuery() } as unknown as EntityManager });

        expect(statusPublication.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            dispatchId: 55, status: 'incident', receipt: expect.objectContaining({ result: 'rejected' }),
        }));
    });

    it('keeps the outbound record version in the dispatch event so the next publication continues the sequence', async () => {
        const { service, statusPublication, dispatchEvents } = build();
        statusPublication.publish.mockResolvedValue(3);

        await service.apply({ ...data, result: 'rejected' }, { manager: { query: incidentQuery() } as unknown as EntityManager });

        expect(dispatchEvents.create.mock.calls[0][0].metadata).toMatchObject({ receiptId: 'RCPT-1', result: 'rejected', outboundRecordVersion: 3 });
    });

    it('returns the socket events: the status change and, with a difference, the incident alert', async () => {
        const { service, dispatchIncidents } = build();

        const result = await service.apply(
            { ...data, result: 'with_differences' },
            { manager: { query: incidentQuery() } as unknown as EntityManager },
        );

        const created = dispatchIncidents.create.mock.calls[0][0];
        expect(result).toMatchObject({
            status: 'applied',
            events: {
                statusChanged: { dispatchId: 55, status: 'incident', previousStatus: 'picked_up_in_transit', version: 4, updatedAt: '2026-11-08T12:00:01.000Z' },
                incidentReported: {
                    dispatchId: 55, incidentId: created.id, reasonCode: 'INC-RECEIPT-DIFF',
                    reportedAt: '2026-11-08T12:00:00.000Z', criticality: 'high',
                },
            },
        });
    });

    it('requires the inbound transaction manager', async () => {
        const { service } = build();
        await expect(service.apply(data, {})).rejects.toThrow('inbound transaction manager');
    });
});
