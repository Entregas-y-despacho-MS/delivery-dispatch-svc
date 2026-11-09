import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { MessageHandler } from '../../../../plugins/messaging/message-bus.port.js';
import { DISPATCH_CHANGE_REQUIRES_ATTENTION } from '../../sales-order-intake/services/dispatch-change-events.service.js';
import { INVENTORY_RECEIPT_CONFIRMED_TOPIC, WarehouseReceiptConsumer } from './warehouse-receipt-consumer.service.js';

const data = {
    receiptId: 'RCPT-1',
    referenceType: 'rma',
    referenceId: 'RMA-1',
    result: 'complete',
    receivedAt: '2026-11-08T12:00:00Z',
    recordVersion: 1,
};

function envelope(over: Record<string, unknown> = {}, messageId = '0199f8c0-0000-7000-8000-000000000003'): MessageEnvelope {
    return { messageId, type: INVENTORY_RECEIPT_CONFIRMED_TOPIC, source: 'inventory', schemaVersion: 1, occurredAt: '2026-11-08T12:00:00Z', data: { ...data, ...over } };
}

describe('WarehouseReceiptConsumer', () => {
    let handler: MessageHandler | undefined;
    const bus = { subscribe: vi.fn(async (_topic: string, h: MessageHandler) => { handler = h; }) };
    const transaction = {
        process: vi.fn(async (_envelope: MessageEnvelope, _id: string, handle: (options: object) => Promise<void>) => {
            await handle({ manager: {} });
            return 'receipt-committed' as const;
        }),
    };
    const receipts = { apply: vi.fn() };
    const events = { emit: vi.fn() };
    let consumer: WarehouseReceiptConsumer;

    const send = async (over?: Record<string, unknown>, messageId?: string) => {
        expect(handler).toBeDefined();
        return await handler!(envelope(over, messageId));
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        handler = undefined;
        transaction.process.mockImplementation(async (_envelope, _id, handle) => {
            await handle({ manager: {} });
            return 'receipt-committed';
        });
        consumer = new WarehouseReceiptConsumer(bus as never, transaction as never, receipts as never, events as never);
        await consumer.onModuleInit();
    });

    it('subscribes to inventory.receipt.confirmed', () => {
        expect(bus.subscribe).toHaveBeenCalledWith(INVENTORY_RECEIPT_CONFIRMED_TOPIC, expect.any(Function));
    });

    it('serializes by referenceId, not receiptId: two different receipts for the same traslado must share the lock', async () => {
        await send();

        expect(transaction.process).toHaveBeenCalledWith(expect.anything(), 'RMA-1', expect.any(Function));
    });

    it('does not emit anything for a duplicate message', async () => {
        transaction.process.mockResolvedValueOnce('duplicate');

        const result = await send();

        expect(result).toBe('duplicate');
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not emit anything when the receipt was ignored (stale recordVersion)', async () => {
        receipts.apply.mockResolvedValue({ status: 'ignored' });

        await send();

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('emits dispatch.change_requires_attention with the dispatchId when a known dispatch is not picked_up_in_transit', async () => {
        receipts.apply.mockResolvedValue({ status: 'orphan', dispatchId: 55, referenceId: 'RMA-1' });

        await send();

        expect(events.emit).toHaveBeenCalledWith(DISPATCH_CHANGE_REQUIRES_ATTENTION, expect.objectContaining({
            dispatchId: 55, salesOrderId: undefined, source: 'inventory', changeType: 'orphan_receipt',
        }));
    });

    it('emits dispatch.change_requires_attention with the referenceId when nothing resolved at all', async () => {
        receipts.apply.mockResolvedValue({ status: 'orphan', dispatchId: null, referenceId: 'RMA-1' });

        await send();

        expect(events.emit).toHaveBeenCalledWith(DISPATCH_CHANGE_REQUIRES_ATTENTION, expect.objectContaining({
            dispatchId: undefined, salesOrderId: 'RMA-1', changeType: 'orphan_receipt',
        }));
    });

    it('emits dispatch.change_requires_attention with receipt_correction when a correction arrives on an already-applied receipt', async () => {
        receipts.apply.mockResolvedValue({ status: 'correction', dispatchId: 55 });

        await send();

        expect(events.emit).toHaveBeenCalledWith(DISPATCH_CHANGE_REQUIRES_ATTENTION, expect.objectContaining({
            dispatchId: 55, source: 'inventory', changeType: 'receipt_correction',
        }));
    });

    const statusChanged = { dispatchId: 55, status: 'returned_to_warehouse', previousStatus: 'picked_up_in_transit', version: 3, updatedAt: '2026-11-08T12:00:01.000Z' };
    const incidentReported = { dispatchId: 55, incidentId: 'inc-1', reasonCode: 'INC-RECEIPT-DIFF', reportedAt: '2026-11-08T12:00:00.000Z', criticality: 'high' };

    it('emits dispatch.status_changed after commit when the receipt was applied, and no incident alert', async () => {
        receipts.apply.mockResolvedValue({ status: 'applied', dispatchId: 55, newStatus: 'returned_to_warehouse', events: { statusChanged } });

        await send();

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(events.emit).toHaveBeenCalledWith('dispatch.status_changed', statusChanged);
    });

    it('also emits dispatch.incident_reported when the receipt opened an incident', async () => {
        receipts.apply.mockResolvedValue({
            status: 'applied', dispatchId: 55, newStatus: 'incident',
            events: { statusChanged: { ...statusChanged, status: 'incident' }, incidentReported },
        });

        await send({ result: 'with_differences' });

        expect(events.emit).toHaveBeenCalledWith('dispatch.status_changed', expect.objectContaining({ status: 'incident' }));
        expect(events.emit).toHaveBeenCalledWith('dispatch.incident_reported', incidentReported);
    });

    it('emits nothing when the transaction fails: the error reaches the bus and nothing was committed', async () => {
        transaction.process.mockRejectedValue(new Error('db down'));

        await expect(send()).rejects.toThrow('db down');

        expect(events.emit).not.toHaveBeenCalled();
    });

    it('still emits the incident alert when the status listener throws', async () => {
        receipts.apply.mockResolvedValue({
            status: 'applied', dispatchId: 55, newStatus: 'incident',
            events: { statusChanged: { ...statusChanged, status: 'incident' }, incidentReported },
        });
        events.emit.mockImplementationOnce(() => { throw new Error('listener failed'); });

        const result = await send({ result: 'rejected' });

        expect(result).toBe('receipt-committed');
        expect(events.emit).toHaveBeenCalledWith('dispatch.incident_reported', incidentReported);
    });

    it('does not turn a failing listener into a retry', async () => {
        receipts.apply.mockResolvedValue({ status: 'orphan', dispatchId: null, referenceId: 'RMA-1' });
        events.emit.mockImplementation(() => { throw new Error('listener failed'); });

        const result = await send();

        expect(result).toBe('receipt-committed');
    });
});
