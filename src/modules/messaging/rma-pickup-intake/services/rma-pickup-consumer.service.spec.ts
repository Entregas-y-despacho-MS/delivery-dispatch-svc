import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { MessageHandler } from '../../../../plugins/messaging/message-bus.port.js';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../../../app/dispatch-status/dispatch-status-changed.event.js';
import { INVENTORY_RETURN_REQUESTED_TOPIC, RmaPickupConsumer } from './rma-pickup-consumer.service.js';

const RMA_ID = 'RMA-2026-000042';
const requested = {
    rmaId: RMA_ID,
    recordVersion: 1,
    updatedAt: '2026-11-03T14:00:00Z',
    approvedAt: '2026-11-03T13:00:00Z',
    warehouseId: 'WH-LPZ-01',
    contact: { name: 'Cliente Uno', phone: '77712345' },
    pickupAddress: { line: 'Av. Siempre Viva 123', location: { latitude: -17.78, longitude: -63.18 } },
    returnReason: 'Producto defectuoso',
};

function envelope(data: Record<string, unknown>, messageId = '0199f8c0-0000-7000-8000-000000000002'): MessageEnvelope {
    return { messageId, type: INVENTORY_RETURN_REQUESTED_TOPIC, source: 'inventory', schemaVersion: 1, occurredAt: '2026-11-03T14:00:00Z', data };
}

describe('RmaPickupConsumer', () => {
    let handler: MessageHandler | undefined;
    const bus = {
        subscribe: vi.fn(async (_topic: string, h: MessageHandler) => {
            handler = h;
        }),
    };
    const transaction = {
        process: vi.fn(async (_envelope: MessageEnvelope, _id: string, handle: (options: object) => Promise<void>) => {
            await handle({ manager: {} });
            return 'receipt-committed' as const;
        }),
    };
    const syncStates = { find: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
    const pickups = { createFromRma: vi.fn() };
    const events = { emit: vi.fn() };
    let consumer: RmaPickupConsumer;

    const send = async (data: Record<string, unknown>, messageId?: string) => {
        expect(handler).toBeDefined();
        return await handler!(envelope(data, messageId));
    };

    beforeEach(async () => {
        vi.clearAllMocks();
        handler = undefined;
        syncStates.find.mockResolvedValue(null);
        pickups.createFromRma.mockResolvedValue({ dispatchId: 10, status: 'pickup_scheduled' });
        transaction.process.mockImplementation(async (_envelope, _id, handle) => {
            await handle({ manager: {} });
            return 'receipt-committed';
        });
        consumer = new RmaPickupConsumer(bus as never, transaction as never, syncStates as never, pickups as never, events as never);
        await consumer.onModuleInit();
    });

    it('subscribes to the RMA topic', () => {
        expect(bus.subscribe).toHaveBeenCalledWith(INVENTORY_RETURN_REQUESTED_TOPIC, expect.any(Function));
    });

    it('creates the pickup order, saves the sync state and notifies coordinators', async () => {
        await send(requested);

        expect(transaction.process).toHaveBeenCalledWith(expect.objectContaining({ type: INVENTORY_RETURN_REQUESTED_TOPIC }), RMA_ID, expect.any(Function));
        expect(pickups.createFromRma).toHaveBeenCalledWith(requested, { manager: {} });
        expect(syncStates.save).toHaveBeenCalledWith({ rmaId: RMA_ID, lastRecordVersion: 1 }, { manager: {} });
        expect(events.emit).toHaveBeenCalledWith(
            DISPATCH_STATUS_CHANGED_EVENT,
            expect.objectContaining({ dispatchId: 10, status: 'pickup_scheduled', previousStatus: 'pickup_scheduled' }),
        );
    });

    it('ignores a message whose recordVersion is not newer than the one already stored', async () => {
        syncStates.find.mockResolvedValue({ rmaId: RMA_ID, lastRecordVersion: 1 });

        await send({ ...requested, recordVersion: 1 });

        expect(pickups.createFromRma).not.toHaveBeenCalled();
        expect(syncStates.save).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not notify coordinators for a repeated messageId', async () => {
        transaction.process.mockResolvedValue('duplicate');

        await send(requested);

        expect(pickups.createFromRma).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });

    it('propagates the rejection of an unknown warehouse without saving the sync state', async () => {
        const rejection = new RejectedMessageException([{ path: '/data/warehouseId', keyword: 'unknownWarehouse', message: 'Unknown warehouse.' }], 'unknown_warehouse');
        pickups.createFromRma.mockRejectedValue(rejection);

        await expect(send(requested)).rejects.toBe(rejection);

        expect(syncStates.save).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
    });
});
