import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import { generateMessageId } from '../../../../plugins/messaging/envelope/uuid-v7.js';
import {
    InboundMessageTransaction,
    type TransactionalMessageResult,
    type TransactionOptions,
} from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MemoryInboundMessageLogAdapter } from '../../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MemoryMessageBusAdapter } from '../../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { MemoryOrderSyncStateAdapter } from '../../sales-order-sync/memory/memory-order-sync-state.adapter.js';
import { MemoryPendingSalesOrderStore } from '../memory/memory-pending-sales-order.store.js';
import { MarketplaceOrderRepository } from '../repositories/marketplace-order.repository.js';
import { MARKETPLACE_ORDER_TOPICS, MarketplaceOrderConsumer } from './marketplace-order-consumer.service.js';

const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const ORDER = 'SO-2026-000123';

/**
 * Stand-in for the TypeORM adapter of `InboundMessageTransaction`: same contract (a repeated
 * `processed` message is a `duplicate`, a failing handler leaves no receipt) with no rollback of
 * what the handler already wrote — that is only checked against a real PostgreSQL.
 */
class FakeInboundMessageTransaction extends InboundMessageTransaction {
    readonly processed = new Set<string>();
    readonly calls: { messageId: string; salesOrderId: string }[] = [];

    async process(
        envelope: MessageEnvelope,
        salesOrderId: string,
        handle: (options: TransactionOptions) => Promise<void>,
    ): Promise<TransactionalMessageResult> {
        this.calls.push({ messageId: envelope.messageId, salesOrderId });
        if (this.processed.has(envelope.messageId)) return 'duplicate';

        await handle({ manager: undefined });
        this.processed.add(envelope.messageId);
        return 'receipt-committed';
    }
}

function example(topic: string): MessageEnvelope {
    const file = resolve(CONTRACTS_DIR, 'examples', `${topic}.example.json`);
    return JSON.parse(readFileSync(file, 'utf8')) as MessageEnvelope;
}

/** A valid message of the topic, with a fresh `messageId` and the data fields overridden. */
function message(topic: string, data: Record<string, unknown> = {}): MessageEnvelope {
    const base = example(topic);
    return { ...base, messageId: generateMessageId(), data: { ...base.data, ...data } };
}

describe('MarketplaceOrderConsumer', () => {
    let bus: MemoryMessageBusAdapter;
    let transaction: FakeInboundMessageTransaction;
    let syncStates: MemoryOrderSyncStateAdapter;
    let pending: MemoryPendingSalesOrderStore;
    let orders: MarketplaceOrderRepository;

    beforeEach(async () => {
        syncStates = new MemoryOrderSyncStateAdapter();
        pending = new MemoryPendingSalesOrderStore();
        orders = new MarketplaceOrderRepository(syncStates, pending);
        bus = new MemoryMessageBusAdapter(
            MessageValidator.fromDirectory(CONTRACTS_DIR),
            new MemoryInboundMessageLogAdapter(),
        );
        transaction = new FakeInboundMessageTransaction();

        await new MarketplaceOrderConsumer(bus, transaction, orders).onModuleInit();
    });

    it('stores the order of a valid confirmed message', async () => {
        const confirmed = message(MARKETPLACE_ORDER_TOPICS.confirmed);

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(outcome).toBe('processed');
        const state = await orders.find(ORDER);
        expect(state).toMatchObject({
            lastRecordVersion: 1,
            baseReceived: true,
            cancelledAt: null,
        });
        expect(state?.blocks.confirmedAt).toBe('2026-10-07T13:39:42Z');
        expect(state?.blocks.recipient?.name).toBe('María Fernández Quispe');
        expect(state?.blocks.deliveryAddress?.location).toEqual({ latitude: -16.5115, longitude: -68.1223 });
        expect(transaction.processed.has(confirmed.messageId)).toBe(true);
    });

    it('runs each message inside the transaction of its order', async () => {
        const confirmed = message(MARKETPLACE_ORDER_TOPICS.confirmed);

        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(transaction.calls).toEqual([{ messageId: confirmed.messageId, salesOrderId: ORDER }]);
    });

    it('does not apply the same messageId twice', async () => {
        const confirmed = message(MARKETPLACE_ORDER_TOPICS.confirmed);
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);
        const before = await orders.find(ORDER);

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(outcome).toBe('duplicate');
        expect(await orders.find(ORDER)).toEqual(before);
    });

    it('ignores another message with the same version, but still commits its receipt', async () => {
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, message(MARKETPLACE_ORDER_TOPICS.confirmed));
        const before = await orders.find(ORDER);
        const repeated = message(MARKETPLACE_ORDER_TOPICS.confirmed, {
            recipient: { name: 'Otra Persona', phone: '+59170000000' },
        });

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, repeated);

        expect(outcome).toBe('processed');
        expect(await orders.find(ORDER)).toEqual(before);
        expect(transaction.processed.has(repeated.messageId)).toBe(true);
    });

    it('replaces a whole block with an updated message and keeps the rest', async () => {
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, message(MARKETPLACE_ORDER_TOPICS.confirmed));

        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.updated, message(MARKETPLACE_ORDER_TOPICS.updated));

        const state = await orders.find(ORDER);
        expect(state?.lastRecordVersion).toBe(2);
        expect(state?.blocks.deliveryAddress).toEqual({
            line: 'Calle 21 de Calacoto 8790, casa 12',
            reference: 'Condominio Las Palmas, segunda garita',
            location: { latitude: -16.5421, longitude: -68.0802 },
        });
        expect(state?.blocks.recipient?.email).toBe('maria.fernandez@example.com');
        expect(state?.blocks.confirmedAt).toBe('2026-10-07T13:39:42Z');
    });

    it('keeps an updated that arrives before the confirmed and completes it later without lowering the version', async () => {
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.updated, message(MARKETPLACE_ORDER_TOPICS.updated));
        const waiting = await orders.find(ORDER);
        expect(waiting).toMatchObject({ baseReceived: false, lastRecordVersion: 2 });

        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, message(MARKETPLACE_ORDER_TOPICS.confirmed));

        const state = await orders.find(ORDER);
        expect(state).toMatchObject({ baseReceived: true, lastRecordVersion: 2 });
        // The address of the updated is newer and wins; the recipient comes from the late confirmed.
        expect(state?.blocks.deliveryAddress?.line).toBe('Calle 21 de Calacoto 8790, casa 12');
        expect(state?.blocks.recipient?.name).toBe('María Fernández Quispe');
        expect(state?.blocks.confirmedAt).toBe('2026-10-07T13:39:42Z');
    });

    it('records a cancellation even when the order never had a base, and a late confirmed cannot revive it', async () => {
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.cancelled, message(MARKETPLACE_ORDER_TOPICS.cancelled));
        expect(await orders.find(ORDER)).toMatchObject({
            baseReceived: false,
            cancelledAt: '2026-10-08T16:29:50Z',
            cancelledVersion: 3,
        });

        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, message(MARKETPLACE_ORDER_TOPICS.confirmed));

        const state = await orders.find(ORDER);
        expect(state?.baseReceived).toBe(false);
        expect(state?.cancelledVersion).toBe(3);
        expect(state?.blocks.recipient).toBeUndefined();
    });

    it('keeps each order apart', async () => {
        await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, message(MARKETPLACE_ORDER_TOPICS.confirmed));

        await bus.publishRaw(
            MARKETPLACE_ORDER_TOPICS.confirmed,
            message(MARKETPLACE_ORDER_TOPICS.confirmed, { salesOrderId: 'SO-2026-000999' }),
        );

        expect((await orders.find(ORDER))?.salesOrderId).toBe(ORDER);
        expect((await orders.find('SO-2026-000999'))?.salesOrderId).toBe('SO-2026-000999');
    });

    it('accepts an order without email and without coordinates', async () => {
        const confirmed = message(MARKETPLACE_ORDER_TOPICS.confirmed, {
            recipient: { name: 'Juan Pérez', phone: '+59171111111' },
            deliveryAddress: { line: 'Calle 21 de Calacoto' },
        });

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(outcome).toBe('processed');
        const state = await orders.find(ORDER);
        expect(state?.blocks.recipient).toEqual({ name: 'Juan Pérez', phone: '+59171111111' });
        expect(state?.blocks.deliveryAddress?.location).toBeUndefined();
    });

    it('sends an invalid message to the dead-letter and writes nothing', async () => {
        const invalid = message(MARKETPLACE_ORDER_TOPICS.confirmed);
        delete (invalid.data as Record<string, unknown>).recipient;

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, invalid);

        expect(outcome).toBe('rejected');
        expect(bus.deadLettersOf(MARKETPLACE_ORDER_TOPICS.confirmed)).toHaveLength(1);
        expect(transaction.calls).toHaveLength(0);
        expect(await orders.find(ORDER)).toBeNull();
    });

    it('rejects a field that the contract does not declare, such as payment data', async () => {
        const withPayment = message(MARKETPLACE_ORDER_TOPICS.confirmed, { paymentMethod: 'card' });

        const outcome = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, withPayment);

        expect(outcome).toBe('rejected');
        expect(await orders.find(ORDER)).toBeNull();
    });

    it('leaves no receipt when the handler fails, so the broker redelivers it', async () => {
        const confirmed = message(MARKETPLACE_ORDER_TOPICS.confirmed);
        const originalSave = orders.save.bind(orders);
        let failures = 1;
        orders.save = async (state, options) => {
            if (failures-- > 0) throw new Error('database unavailable');
            await originalSave(state, options);
        };

        const first = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(first).toBeNull();
        expect(bus.handlerErrors).toHaveLength(1);
        expect(transaction.processed.has(confirmed.messageId)).toBe(false);

        const second = await bus.publishRaw(MARKETPLACE_ORDER_TOPICS.confirmed, confirmed);

        expect(second).toBe('processed');
        expect((await orders.find(ORDER))?.baseReceived).toBe(true);
    });

    it('subscribes to the three Marketplace topics and to no other', async () => {
        const other = new MemoryMessageBusAdapter(
            MessageValidator.fromDirectory(CONTRACTS_DIR),
            new MemoryInboundMessageLogAdapter(),
        );
        const subscribed: string[] = [];
        const original = other.subscribe.bind(other);
        other.subscribe = async (topic, handler) => {
            subscribed.push(topic);
            await original(topic, handler);
        };

        await new MarketplaceOrderConsumer(other, transaction, orders).onModuleInit();

        expect(subscribed.sort()).toEqual([
            'marketplace.sales_order.cancelled',
            'marketplace.sales_order.confirmed',
            'marketplace.sales_order.updated',
        ]);
    });
});
