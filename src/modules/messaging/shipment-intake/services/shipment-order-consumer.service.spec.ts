import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { MessageHandler } from '../../../../plugins/messaging/message-bus.port.js';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import type { DispatchChangeOutcome } from '../../sales-order-intake/ports/existing-dispatch-changes.port.js';
import { SHIPMENT_TOPICS, ShipmentOrderConsumer } from './shipment-order-consumer.service.js';

const ORDER = 'SO-2026-000123';
const readyData = {
    salesOrderId: ORDER, recordVersion: 1, updatedAt: '2026-10-12T14:00:00Z',
    warehouseId: 'WH-LPZ-01',
    packages: [{ packageId: 'PK-1', lengthCm: 10, widthCm: 20, heightCm: 30, grossWeightKg: 2.5 }],
};

function envelope(type: string, data: Record<string, unknown>, messageId = '0199f8c0-0000-7000-8000-000000000001'): MessageEnvelope {
    return { messageId, type, source: 'inventory', schemaVersion: 1, occurredAt: '2026-10-12T14:00:00Z', data };
}

describe('ShipmentOrderConsumer', () => {
    const handlers = new Map<string, MessageHandler>();
    const bus = { subscribe: vi.fn(async (topic: string, handler: MessageHandler) => { handlers.set(topic, handler); }) };
    const transaction = { process: vi.fn(async (_message: MessageEnvelope, _order: string, handle: (options: object) => Promise<void>) => {
        await handle({ manager: undefined });
        return 'receipt-committed' as const;
    }) };
    const orders = { find: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined) };
    const warehouses = { exists: vi.fn().mockResolvedValue(true) };
    const consolidator = { tryConsolidate: vi.fn().mockResolvedValue({ status: 'waiting', waitingFor: ['marketplace_base'] }) };
    const dispatchChanges = {
        cancel: vi.fn().mockResolvedValue({ status: 'applied', dispatchId: 42 }),
        setShipmentReady: vi.fn().mockResolvedValue({ status: 'applied', dispatchId: 42 }),
    };
    const events = { emitAfterCommit: vi.fn() };

    const send = async (type: string, data: Record<string, unknown>) => {
        const handler = handlers.get(type);
        expect(handler).toBeDefined();
        return await handler!(envelope(type, data));
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        handlers.clear();
        orders.find.mockResolvedValue(null);
        warehouses.exists.mockResolvedValue(true);
        consolidator.tryConsolidate.mockResolvedValue({ status: 'waiting', waitingFor: ['marketplace_base'] });
        dispatchChanges.cancel.mockResolvedValue({ status: 'applied', dispatchId: 42 });
        dispatchChanges.setShipmentReady.mockResolvedValue({ status: 'applied', dispatchId: 42 });
        transaction.process.mockImplementation(async (_message, _order, handle) => {
            await handle({ manager: undefined });
            return 'receipt-committed';
        });
        await new ShipmentOrderConsumer(
            bus as never, transaction as never, orders as never, warehouses as never,
            consolidator as never, dispatchChanges as never, events as never,
        ).onModuleInit();
    });

    it('registers all topics and stores a ready shipment before asking the consolidator', async () => {
        expect([...handlers.keys()]).toEqual(Object.values(SHIPMENT_TOPICS));

        expect(await send(SHIPMENT_TOPICS.ready, readyData)).toBe('receipt-committed');

        expect(transaction.process).toHaveBeenCalledWith(expect.objectContaining({ type: SHIPMENT_TOPICS.ready }), ORDER, expect.any(Function));
        expect(orders.save).toHaveBeenCalledWith(expect.objectContaining({
            salesOrderId: ORDER, baseReceived: true, lastRecordVersion: 1,
            blocks: expect.objectContaining({ warehouseId: 'WH-LPZ-01', isReady: true }),
        }), { manager: undefined });
        expect(consolidator.tryConsolidate).toHaveBeenCalledWith(ORDER, { manager: undefined });
        expect(dispatchChanges.setShipmentReady).not.toHaveBeenCalled();
        expect(events.emitAfterCommit).toHaveBeenCalledWith([]);
    });

    it('propagates isReady false only when the order already was a dispatch', async () => {
        consolidator.tryConsolidate.mockResolvedValue({ status: 'already_consolidated', dispatchId: 42 });
        const updated = { ...readyData, recordVersion: 2, isReady: false, reason: 'warehouse hold' };

        await send(SHIPMENT_TOPICS.updated, updated);

        expect(dispatchChanges.setShipmentReady).toHaveBeenCalledWith({
            salesOrderId: ORDER, source: 'inventory', ready: false,
            receivedAt: updated.updatedAt, reason: 'warehouse hold',
        }, { manager: undefined });
        expect(events.emitAfterCommit).toHaveBeenCalledWith([{ status: 'applied', dispatchId: 42 }]);
    });

    it('a later ready restores readiness on an existing dispatch', async () => {
        consolidator.tryConsolidate.mockResolvedValue({ status: 'already_consolidated', dispatchId: 42 });

        await send(SHIPMENT_TOPICS.ready, readyData);

        expect(dispatchChanges.setShipmentReady).toHaveBeenCalledWith(expect.objectContaining({
            salesOrderId: ORDER, source: 'inventory', ready: true,
        }), { manager: undefined });
    });

    it('propagates cancellation and emits attention only after receipt commit', async () => {
        consolidator.tryConsolidate.mockResolvedValue({ status: 'already_consolidated', dispatchId: 42 });
        const outcome: DispatchChangeOutcome = {
            status: 'attention_required', dispatchId: 42,
            event: { dispatchId: 42, source: 'inventory', changeType: 'order_cancelled', receivedAt: '2026-10-12T14:00:00Z' },
        };
        dispatchChanges.cancel.mockResolvedValue(outcome);
        const order: string[] = [];
        transaction.process.mockImplementation(async (_message, _order, handle) => {
            await handle({ manager: undefined });
            order.push('commit');
            return 'receipt-committed';
        });
        events.emitAfterCommit.mockImplementation(() => order.push('emit'));

        await send(SHIPMENT_TOPICS.cancelled, {
            salesOrderId: ORDER, recordVersion: 2, updatedAt: '2026-10-12T14:00:00Z',
            cancelledAt: '2026-10-12T14:00:00Z', reason: 'cancelled by warehouse',
        });

        expect(dispatchChanges.cancel).toHaveBeenCalledWith({
            salesOrderId: ORDER, source: 'inventory', cancelledAt: '2026-10-12T14:00:00Z',
            reason: 'cancelled by warehouse',
        }, { manager: undefined });
        expect(events.emitAfterCommit).toHaveBeenCalledWith([outcome]);
        expect(order).toEqual(['commit', 'emit']);
    });

    it('does not emit when processing fails or the receipt is a duplicate', async () => {
        transaction.process.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(send(SHIPMENT_TOPICS.ready, readyData)).rejects.toThrow('database unavailable');
        expect(events.emitAfterCommit).not.toHaveBeenCalled();

        transaction.process.mockResolvedValueOnce('duplicate');
        expect(await send(SHIPMENT_TOPICS.ready, readyData)).toBe('duplicate');
        expect(events.emitAfterCommit).not.toHaveBeenCalled();
    });

    it('rejects an unknown warehouse before any business write', async () => {
        warehouses.exists.mockResolvedValue(false);

        await expect(send(SHIPMENT_TOPICS.ready, readyData)).rejects.toBeInstanceOf(RejectedMessageException);
        expect(orders.save).not.toHaveBeenCalled();
        expect(consolidator.tryConsolidate).not.toHaveBeenCalled();
        expect(events.emitAfterCommit).not.toHaveBeenCalled();
    });

    it('does not propagate a stale inventory version to an existing dispatch', async () => {
        orders.find.mockResolvedValue({
            salesOrderId: ORDER, lastRecordVersion: 3, baseReceived: true,
            cancelledAt: null, cancelledVersion: null,
            blocks: { warehouseId: 'WH-LPZ-01', packages: readyData.packages, isReady: true },
        });
        consolidator.tryConsolidate.mockResolvedValue({ status: 'already_consolidated', dispatchId: 42 });

        await send(SHIPMENT_TOPICS.updated, { ...readyData, recordVersion: 2, isReady: false });

        expect(orders.save).not.toHaveBeenCalled();
        expect(consolidator.tryConsolidate).not.toHaveBeenCalled();
        expect(dispatchChanges.setShipmentReady).not.toHaveBeenCalled();
    });
});
