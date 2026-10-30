import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { SubscriptionNotFoundException, TopicAlreadySubscribedException } from '../exceptions/index.js';
import { PubsubMessageBusAdapter } from './pubsub-message-bus.adapter.js';
import type { PubsubMessagingConfig } from './pubsub-messaging.config.js';

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

describe('PubsubMessageBusAdapter.subscribe', () => {
    const MESSAGE_ID = '01933b6e-7f2a-7c3d-9a1b-2f8e6c4d5a10';
    const SHARED_TOPIC = 'ucb-sis323-sub-h';
    const SHARED_SUBSCRIPTION = 'ucb-sis323-sub-h-dispatch-svc';
    const LOGICAL_TOPICS = ['marketplace.sales_order.confirmed', 'inventory.shipment.ready'];

    class FakeSubscription extends EventEmitter {
        exists = vi.fn(async () => [true]);
        getMetadata = vi.fn(async () => [{ topic: `projects/test-project/topics/${SHARED_TOPIC}` }]);
        close = vi.fn(async () => undefined);
    }

    const setup = (config: Partial<PubsubMessagingConfig> = {}) => {
        const subscriptions = new Map<string, FakeSubscription>();
        const published: Array<{ topic: string; json: unknown }> = [];
        const client = {
            subscription: vi.fn((name: string) => {
                if (!subscriptions.has(name)) subscriptions.set(name, new FakeSubscription());
                return subscriptions.get(name)!;
            }),
            topic: vi.fn((name: string) => ({
                publishMessage: vi.fn(async ({ json }: { json: unknown }) => {
                    published.push({ topic: name, json });
                    return 'broker-id';
                }),
            })),
            close: vi.fn(async () => undefined),
        };
        // The physical topic has no contract schema, so only logical topics validate.
        const validator = {
            hasTopic: (topic: string) => LOGICAL_TOPICS.includes(topic),
            validate: (topic: string) =>
                LOGICAL_TOPICS.includes(topic)
                    ? { valid: true, errors: [] }
                    : { valid: false, errors: [{ path: '', keyword: 'unknownTopic', message: `Unknown topic ${topic}` }] },
        };
        const log = { wasProcessed: vi.fn(async () => false), record: vi.fn(async () => true) };
        const fullConfig = {
            projectId: 'test-project',
            subscriptionSuffix: 'dispatch-svc',
            inboundTopic: SHARED_TOPIC,
            inboundSubscription: SHARED_SUBSCRIPTION,
            ...config,
        } as PubsubMessagingConfig;
        const bus = new PubsubMessageBusAdapter(client as never, fullConfig, validator as never, log as never);
        return { bus, client, subscriptions, published, log };
    };

    const message = (payload: unknown, attributes: Record<string, string> = {}) => ({
        id: 'pubsub-1',
        data: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
        attributes,
        ack: vi.fn(),
        nack: vi.fn(),
    });
    const envelope = (type?: string) => ({ messageId: MESSAGE_ID, source: 'marketplace', ...(type && { type }) });

    describe('shared subscription', () => {
        it('routes a message to the handler registered for the envelope type and acks it', async () => {
            const { bus, subscriptions } = setup();
            const confirmed = vi.fn(async () => undefined);
            const ready = vi.fn(async () => undefined);
            await bus.subscribe(LOGICAL_TOPICS[0], confirmed);
            await bus.subscribe(LOGICAL_TOPICS[1], ready);
            await bus.onApplicationBootstrap();

            const incoming = message(envelope(LOGICAL_TOPICS[1]), { type: LOGICAL_TOPICS[1] });
            subscriptions.get(SHARED_SUBSCRIPTION)!.emit('message', incoming);

            await vi.waitFor(() => expect(incoming.ack).toHaveBeenCalled());
            expect(ready).toHaveBeenCalledWith(expect.objectContaining({ type: LOGICAL_TOPICS[1] }));
            expect(confirmed).not.toHaveBeenCalled();
            expect(incoming.nack).not.toHaveBeenCalled();
            await bus.onModuleDestroy();
        });

        it.each([
            ['an unknown type', envelope('marketplace.unknown.event')],
            ['a missing type', envelope()],
        ])('sends %s to the dead-letter of the physical topic and acks it', async (_name, payload) => {
            const { bus, subscriptions, published, log } = setup();
            const handler = vi.fn(async () => undefined);
            await bus.subscribe(LOGICAL_TOPICS[0], handler);
            await bus.onApplicationBootstrap();

            const incoming = message(payload);
            subscriptions.get(SHARED_SUBSCRIPTION)!.emit('message', incoming);

            await vi.waitFor(() => expect(incoming.ack).toHaveBeenCalled());
            expect(handler).not.toHaveBeenCalled();
            expect(published).toEqual([
                expect.objectContaining({ topic: `${SHARED_TOPIC}.dead-letter`, json: expect.objectContaining({ message: payload }) }),
            ]);
            expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', type: SHARED_TOPIC }));
            await bus.onModuleDestroy();
        });

        it('rejects a message whose type attribute differs from the envelope type', async () => {
            const { bus, subscriptions, published } = setup();
            const handler = vi.fn(async () => undefined);
            await bus.subscribe(LOGICAL_TOPICS[0], handler);
            await bus.onApplicationBootstrap();

            const incoming = message(envelope(LOGICAL_TOPICS[0]), { type: LOGICAL_TOPICS[1] });
            subscriptions.get(SHARED_SUBSCRIPTION)!.emit('message', incoming);

            await vi.waitFor(() => expect(incoming.ack).toHaveBeenCalled());
            expect(handler).not.toHaveBeenCalled();
            expect(published.map((entry) => entry.topic)).toEqual([`${SHARED_TOPIC}.dead-letter`]);
            await bus.onModuleDestroy();
        });

        it('nacks a message whose handler fails so the broker redelivers it', async () => {
            const { bus, subscriptions } = setup();
            await bus.subscribe(LOGICAL_TOPICS[0], async () => {
                throw new Error('database down');
            });
            await bus.onApplicationBootstrap();

            const incoming = message(envelope(LOGICAL_TOPICS[0]));
            subscriptions.get(SHARED_SUBSCRIPTION)!.emit('message', incoming);

            await vi.waitFor(() => expect(incoming.nack).toHaveBeenCalled());
            expect(incoming.ack).not.toHaveBeenCalled();
            await bus.onModuleDestroy();
        });

        it('fails to start when the subscription does not exist', async () => {
            const { bus, subscriptions, client } = setup();
            await bus.subscribe(LOGICAL_TOPICS[0], async () => undefined);
            const missing = new FakeSubscription();
            missing.exists.mockResolvedValue([false]);
            subscriptions.set(SHARED_SUBSCRIPTION, missing);

            await expect(bus.onApplicationBootstrap()).rejects.toBeInstanceOf(SubscriptionNotFoundException);
            expect(client.subscription).toHaveBeenCalledWith(SHARED_SUBSCRIPTION);
        });

        it('fails to start when the subscription is attached to another topic', async () => {
            const { bus, subscriptions } = setup();
            await bus.subscribe(LOGICAL_TOPICS[0], async () => undefined);
            const other = new FakeSubscription();
            other.getMetadata.mockResolvedValue([{ topic: 'projects/test-project/topics/another-topic' }]);
            subscriptions.set(SHARED_SUBSCRIPTION, other);

            await expect(bus.onApplicationBootstrap()).rejects.toThrow(
                `attached to projects/test-project/topics/another-topic, expected projects/test-project/topics/${SHARED_TOPIC}`,
            );
        });

        it('rejects registering the same logical topic twice', async () => {
            const { bus } = setup();
            await bus.subscribe(LOGICAL_TOPICS[0], async () => undefined);

            await expect(bus.subscribe(LOGICAL_TOPICS[0], async () => undefined)).rejects.toBeInstanceOf(
                TopicAlreadySubscribedException,
            );
        });
    });

    describe('incomplete shared configuration', () => {
        it.each([
            ['only the topic', { inboundSubscription: undefined }],
            ['only the subscription', { inboundTopic: undefined }],
        ])('rejects subscribe with %s', async (_name, config) => {
            const { bus } = setup(config);

            await expect(bus.subscribe(LOGICAL_TOPICS[0], async () => undefined)).rejects.toThrow(
                'PUBSUB_INBOUND_TOPIC and PUBSUB_INBOUND_SUBSCRIPTION must be configured together.',
            );
        });
    });

    describe('without shared configuration', () => {
        const legacy = { inboundTopic: undefined, inboundSubscription: undefined };

        it('keeps one subscription per logical topic named <topic>.<suffix>', async () => {
            const { bus, client, subscriptions } = setup(legacy);
            const handler = vi.fn(async () => undefined);
            await bus.subscribe(LOGICAL_TOPICS[0], handler);
            await bus.subscribe(LOGICAL_TOPICS[1], async () => undefined);
            await bus.onApplicationBootstrap();

            expect(client.subscription).toHaveBeenCalledWith(`${LOGICAL_TOPICS[0]}.dispatch-svc`);
            expect(client.subscription).toHaveBeenCalledWith(`${LOGICAL_TOPICS[1]}.dispatch-svc`);
            expect(subscriptions.has(SHARED_SUBSCRIPTION)).toBe(false);

            const incoming = message(envelope(LOGICAL_TOPICS[0]));
            subscriptions.get(`${LOGICAL_TOPICS[0]}.dispatch-svc`)!.emit('message', incoming);
            await vi.waitFor(() => expect(incoming.ack).toHaveBeenCalled());
            expect(handler).toHaveBeenCalledTimes(1);
            await bus.onModuleDestroy();
        });

        it('fails when the per-topic subscription does not exist', async () => {
            const { bus, subscriptions } = setup(legacy);
            const missing = new FakeSubscription();
            missing.exists.mockResolvedValue([false]);
            subscriptions.set(`${LOGICAL_TOPICS[0]}.dispatch-svc`, missing);

            await expect(bus.subscribe(LOGICAL_TOPICS[0], async () => undefined)).rejects.toBeInstanceOf(
                SubscriptionNotFoundException,
            );
        });
    });
});
