import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { PubsubMessageBusAdapter } from './pubsub-message-bus.adapter.js';

describe('PubsubMessageBusAdapter.publish', () => {
    it('exposes the delivery status as a Pub/Sub attribute for subscription routing', async () => {
        const publishMessage = vi.fn().mockResolvedValue('message-id');
        const client = { topic: vi.fn(() => ({ publishMessage })), close: vi.fn() };
        const bus = new PubsubMessageBusAdapter(client as never, {} as never, {} as never, {} as never);
        const message = {
            messageId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10',
            type: 'dispatch.transfer.status_changed',
            source: 'dispatch',
            schemaVersion: 1,
            occurredAt: '2026-10-18T10:00:00.000Z',
            data: { status: 'incident' },
        } as MessageEnvelope;

        await bus.publish(message.type, message);

        expect(publishMessage).toHaveBeenCalledWith({
            json: message,
            attributes: {
                messageId: message.messageId,
                type: message.type,
                source: message.source,
                schemaVersion: '1',
                status: 'incident',
            },
        });
        await bus.onModuleDestroy();
    });

    it('does not add a delivery status attribute to other topics', async () => {
        const publishMessage = vi.fn().mockResolvedValue('message-id');
        const client = { topic: vi.fn(() => ({ publishMessage })), close: vi.fn() };
        const bus = new PubsubMessageBusAdapter(client as never, {} as never, {} as never, {} as never);
        const message = {
            messageId: '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10',
            type: 'dispatch.shipment.departed',
            source: 'dispatch',
            schemaVersion: 1,
            occurredAt: '2026-10-18T10:00:00.000Z',
            data: { status: 'incident' },
        } as MessageEnvelope;

        await bus.publish(message.type, message);

        expect(publishMessage.mock.calls[0][0].attributes).not.toHaveProperty('status');
        await bus.onModuleDestroy();
    });
});
