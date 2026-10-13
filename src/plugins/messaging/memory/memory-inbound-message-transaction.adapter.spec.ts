import { describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { MemoryInboundMessageLogAdapter } from './memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from './memory-inbound-message-transaction.adapter.js';

const envelope: MessageEnvelope = {
    messageId: '0199f8c0-0000-7000-8000-000000000001',
    type: 'inventory.shipment.ready', source: 'inventory', schemaVersion: 1,
    occurredAt: '2026-10-12T14:00:00Z', data: { salesOrderId: 'SO-1' },
};

describe('MemoryInboundMessageTransactionAdapter', () => {
    it('commits the state and processed receipt, then ignores a repeated message', async () => {
        const log = new MemoryInboundMessageLogAdapter();
        const transaction = new MemoryInboundMessageTransactionAdapter(log);
        const calls: number[] = [];

        expect(await transaction.process(envelope, 'SO-1', async () => { calls.push(1); })).toBe('receipt-committed');
        expect(log.get(envelope.messageId)?.status).toBe('processed');
        expect(await transaction.process(envelope, 'SO-1', async () => { calls.push(2); })).toBe('duplicate');
        expect(calls).toEqual([1]);
    });

    it('restores business state and leaves no processed receipt when the handler fails', async () => {
        const log = new MemoryInboundMessageLogAdapter();
        const transaction = new MemoryInboundMessageTransactionAdapter(log);
        const store = {
            value: 0,
            snapshot() { return this.value; },
            restore(value: number) { this.value = value; },
        };
        transaction.registerParticipant(store);

        await expect(transaction.process(envelope, 'SO-1', async () => {
            store.value = 4;
            throw new Error('generator failed');
        })).rejects.toThrow('generator failed');

        expect(store.value).toBe(0);
        expect(log.get(envelope.messageId)).toBeUndefined();
        expect(await transaction.process(envelope, 'SO-1', async () => { store.value = 5; })).toBe('receipt-committed');
        expect(store.value).toBe(5);
    });

    it('serializes two deliveries of the same message while the first is still running', async () => {
        const log = new MemoryInboundMessageLogAdapter();
        const transaction = new MemoryInboundMessageTransactionAdapter(log);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const calls: number[] = [];

        const first = transaction.process(envelope, 'SO-1', async () => { calls.push(1); await gate; });
        const second = transaction.process(envelope, 'SO-1', async () => { calls.push(2); });
        release();

        expect(await Promise.all([first, second])).toEqual(['receipt-committed', 'duplicate']);
        expect(calls).toEqual([1]);
    });
});
