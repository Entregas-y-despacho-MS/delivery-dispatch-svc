import { describe, expect, it, vi } from 'vitest';
import { OutboxService } from '../../messaging/outbound-messages/services/outbox.service.js';
import { DispatchStatusPublicationService } from './dispatch-status-publication.service.js';

function setup(options: {
    dispatch?: { dispatch_type: string; source_order_ref: string; tracking_code: string | null }[];
    versions?: { version: string | null }[];
} = {}) {
    const manager = {
        query: vi.fn(async (sql: string) => {
            if (sql.includes('FROM dispatches d')) return options.dispatch ?? [{
                dispatch_type: 'delivery', source_order_ref: 'SO-1', tracking_code: 'DSP-2026-00001',
            }];
            if (sql.includes('outboundRecordVersion')) return options.versions ?? [];
            throw new Error(`Unexpected SQL: ${sql}`);
        }),
    };
    const outbox = { enqueue: vi.fn().mockResolvedValue(true) };
    const service = new DispatchStatusPublicationService(outbox as unknown as OutboxService);
    return { service, manager, outbox };
}

describe('DispatchStatusPublicationService', () => {
    const input = {
        dispatchId: 11,
        status: 'delivered',
        previousStatus: 'in_transit',
        occurredAt: new Date('2026-10-18T10:00:00.000Z'),
    };

    it('queues a schema-shaped message with a monotonic version and the caller transaction manager', async () => {
        const ctx = setup({ versions: [{ version: '2' }, { version: '1' }] });
        await expect(ctx.service.publish(ctx.manager as never, input)).resolves.toBe(3);

        const [envelope, options] = ctx.outbox.enqueue.mock.calls[0];
        expect(envelope).toMatchObject({
            type: 'dispatch.transfer.status_changed',
            source: 'dispatch',
            occurredAt: '2026-10-18T10:00:00.000Z',
            data: {
                salesOrderId: 'SO-1', trackingCode: 'DSP-2026-00001', status: 'delivered',
                previousStatus: 'in_transit', occurredAt: '2026-10-18T10:00:00.000Z', recordVersion: 3,
            },
        });
        expect(options).toEqual({ manager: ctx.manager });
    });

    it('starts at version one and carries a reason code when present', async () => {
        const ctx = setup();
        await expect(ctx.service.publish(ctx.manager as never, { ...input, status: 'incident', reasonCode: 'INC-CUST-ABSENT' })).resolves.toBe(1);
        expect(ctx.outbox.enqueue.mock.calls[0][0].data).toMatchObject({ recordVersion: 1, reasonCode: 'INC-CUST-ABSENT' });
    });

    it('adds the warehouse result and only the items with differences (ST-240.3)', async () => {
        const ctx = setup({ dispatch: [{ dispatch_type: 'supplier_pickup', source_order_ref: 'PO-9', tracking_code: 'DSP-2026-00002' }] });
        await ctx.service.publish(ctx.manager as never, {
            ...input, status: 'incident', previousStatus: 'picked_up_in_transit',
            receipt: {
                result: 'with_differences',
                items: [
                    { itemCode: 'SKU-1', acceptedQuantity: 8, missingQuantity: 2, damagedQuantity: 0, detail: 'Faltan 2' },
                    { itemCode: 'SKU-2', acceptedQuantity: 5, missingQuantity: 0, damagedQuantity: 0 },
                    { packageId: 41, acceptedQuantity: 0, missingQuantity: 0, damagedQuantity: 3 },
                    { acceptedQuantity: 0, missingQuantity: 1, damagedQuantity: 0 }, // no identifier: cannot satisfy the contract
                ],
            },
        });

        const data = ctx.outbox.enqueue.mock.calls[0][0].data;
        expect(data).toMatchObject({ purchaseOrderId: 'PO-9', status: 'incident', result: 'with_differences' });
        expect(data.items).toEqual([
            { itemCode: 'SKU-1', acceptedQuantity: 8, missingQuantity: 2, damagedQuantity: 0, detail: 'Faltan 2' },
            { packageId: 41, acceptedQuantity: 0, missingQuantity: 0, damagedQuantity: 3 },
        ]);
    });

    it('sends result without items when nothing differs, and nothing receipt-related without a receipt', async () => {
        const ctx = setup({ dispatch: [{ dispatch_type: 'supplier_pickup', source_order_ref: 'PO-9', tracking_code: 'DSP-2026-00002' }] });
        await ctx.service.publish(ctx.manager as never, { ...input, receipt: { result: 'complete', items: [
            { itemCode: 'SKU-1', acceptedQuantity: 10, missingQuantity: 0, damagedQuantity: 0 },
        ] } });
        await ctx.service.publish(ctx.manager as never, input);

        const [withReceipt, without] = ctx.outbox.enqueue.mock.calls.map(([envelope]) => envelope.data);
        expect(withReceipt).toMatchObject({ result: 'complete' });
        expect(withReceipt).not.toHaveProperty('items');
        expect(without).not.toHaveProperty('result');
        expect(without).not.toHaveProperty('items');
    });

    it('does not publish intermediate statuses', async () => {
        const ctx = setup();
        await expect(ctx.service.publish(ctx.manager as never, { ...input, status: 'in_transit' })).resolves.toBeNull();
        expect(ctx.manager.query).not.toHaveBeenCalled();
        expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a result transition without the contract-required tracking code', async () => {
        const ctx = setup({ dispatch: [{ dispatch_type: 'delivery', source_order_ref: 'SO-1', tracking_code: null }] });
        await expect(ctx.service.publish(ctx.manager as never, input)).rejects.toThrow(/tracking code is required/i);
        expect(ctx.outbox.enqueue).not.toHaveBeenCalled();
    });
});
