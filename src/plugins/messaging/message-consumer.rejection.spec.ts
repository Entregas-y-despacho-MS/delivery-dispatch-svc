import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from './envelope/message-envelope.js';
import { RejectedMessageException } from './exceptions/rejected-message.exception.js';
import { MemoryInboundMessageLogAdapter } from './memory/memory-inbound-message-log.adapter.js';
import { MessageConsumer } from './message-consumer.js';

const topic = 'inventory.shipment.ready';
const message: MessageEnvelope = {
    messageId: '0199f8c0-0000-7000-8000-000000000001',
    type: topic, source: 'inventory', schemaVersion: 1,
    occurredAt: '2026-10-12T14:00:00Z', data: { salesOrderId: 'SO-1' },
};

describe('MessageConsumer rejection alerts', () => {
    it('rejects invalid schema before the handler and records the alert after the receipt', async () => {
        const log = new MemoryInboundMessageLogAdapter();
        const deadLetter = vi.fn().mockResolvedValue(undefined);
        const notification = vi.fn(async () => { expect(log.get(message.messageId)?.status).toBe('rejected'); });
        const validator = { validate: vi.fn().mockReturnValue({
            valid: false, errors: [{ path: '/data', keyword: 'required', message: 'warehouseId is required' }],
        }) };
        const consumer = new MessageConsumer(validator as never, log, deadLetter, { notify: notification });
        const handler = vi.fn();

        expect(await consumer.consume(topic, message, handler)).toBe('rejected');
        expect(handler).not.toHaveBeenCalled();
        expect(deadLetter).toHaveBeenCalledOnce();
        expect(notification).toHaveBeenCalledWith(expect.objectContaining({
            messageId: message.messageId, salesOrderId: 'SO-1', reasonCode: 'schema_invalid',
        }));
    });

    it('keeps dead-letter and rejected receipt when alert storage fails', async () => {
        const log = new MemoryInboundMessageLogAdapter();
        const deadLetter = vi.fn().mockResolvedValue(undefined);
        const validator = { validate: vi.fn().mockReturnValue({ valid: true, errors: [] }) };
        const consumer = new MessageConsumer(validator as never, log, deadLetter, {
            notify: vi.fn().mockRejectedValue(new Error('audit unavailable')),
        });
        const handler = vi.fn().mockRejectedValue(new RejectedMessageException([{
            path: '/data/warehouseId', keyword: 'unknownWarehouse', message: 'Unknown warehouse.',
        }], 'unknown_warehouse'));

        expect(await consumer.consume(topic, message, handler)).toBe('rejected');
        expect(deadLetter).toHaveBeenCalledOnce();
        expect(log.get(message.messageId)).toMatchObject({ status: 'rejected', type: topic });
    });
});
