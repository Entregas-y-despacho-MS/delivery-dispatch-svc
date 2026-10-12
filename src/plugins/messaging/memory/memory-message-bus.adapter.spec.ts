import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { generateMessageId } from '../envelope/uuid-v7.js';
import { MessageValidator } from '../envelope/message-validator.js';
import { TopicAlreadySubscribedException, UnknownTopicException } from '../exceptions/index.js';
import { MessageBus } from '../message-bus.port.js';
import { MessagingModule } from '../messaging.module.js';
import { MemoryInboundMessageLogAdapter } from './memory-inbound-message-log.adapter.js';
import { MemoryMessageBusAdapter } from './memory-message-bus.adapter.js';

const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const TOPIC = 'inventory.shipment.ready';

const validMessage = (): MessageEnvelope => {
    const example = JSON.parse(
        readFileSync(resolve(CONTRACTS_DIR, 'examples', `${TOPIC}.example.json`), 'utf8'),
    ) as MessageEnvelope;
    return { ...example, messageId: generateMessageId() };
};

describe('MemoryMessageBusAdapter', () => {
    let log: MemoryInboundMessageLogAdapter;
    let bus: MemoryMessageBusAdapter;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        log = new MemoryInboundMessageLogAdapter();
        bus = new MemoryMessageBusAdapter(MessageValidator.fromDirectory(CONTRACTS_DIR), log);
        handler = vi.fn().mockResolvedValue(undefined);
        await bus.subscribe(TOPIC, handler);
    });

    it('delivers a valid message to the handler and records it as processed', async () => {
        const message = validMessage();

        await bus.publish(TOPIC, message);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(message);
        expect(log.get(message.messageId)).toMatchObject({
            status: 'processed',
            type: TOPIC,
            source: 'inventory',
        });
        expect(bus.deadLettersOf(TOPIC)).toHaveLength(0);
    });

    it('sends an invalid message to the dead-letter with the errors and never calls the handler', async () => {
        const message = validMessage();
        delete (message.data as Record<string, unknown>).warehouseId;

        const outcome = await bus.publishRaw(TOPIC, message);

        expect(outcome).toBe('rejected');
        expect(handler).not.toHaveBeenCalled();
        const [deadLetter] = bus.deadLettersOf(TOPIC);
        expect(deadLetter.originalTopic).toBe(TOPIC);
        expect(deadLetter.message).toEqual(message);
        expect(deadLetter.errors.map((error) => error.message).join(' ')).toContain('warehouseId');
        const receipt = log.get(message.messageId);
        expect(receipt?.status).toBe('rejected');
        expect(JSON.parse(receipt!.errorDetail!)).toEqual(deadLetter.errors);
    });

    it('sends a message that is not even an object to the dead-letter', async () => {
        await bus.publishRaw(TOPIC, 'not json');

        expect(handler).not.toHaveBeenCalled();
        expect(bus.deadLettersOf(TOPIC)).toHaveLength(1);
        expect(bus.deadLettersOf(TOPIC)[0].message).toBe('not json');
    });

    it('ignores a repeated messageId', async () => {
        const message = validMessage();

        await bus.publish(TOPIC, message);
        const second = await bus.publishRaw(TOPIC, message);

        expect(second).toBe('duplicate');
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('runs the handler once when the same message is delivered twice at the same time', async () => {
        const message = validMessage();
        handler.mockImplementation(() => new Promise((done) => setTimeout(done, 20)));

        const outcomes = await Promise.all([bus.publishRaw(TOPIC, message), bus.publishRaw(TOPIC, message)]);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(outcomes.sort()).toEqual(['duplicate', 'processed']);
    });

    it('lets the sender fix a rejected message and resend it with the same messageId', async () => {
        const message = validMessage();
        const broken = { ...message, source: 'marketplace' } as MessageEnvelope;

        await expect(bus.publishRaw(TOPIC, broken)).resolves.toBe('rejected');
        expect(log.get(message.messageId)?.status).toBe('rejected');

        await expect(bus.publishRaw(TOPIC, message)).resolves.toBe('processed');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(log.get(message.messageId)?.status).toBe('processed');
        // From now on it is a plain duplicate.
        await expect(bus.publishRaw(TOPIC, message)).resolves.toBe('duplicate');
    });

    it('does not record a message whose handler failed, so a redelivery is processed', async () => {
        const message = validMessage();
        handler.mockRejectedValueOnce(new Error('database down'));

        await expect(bus.publishRaw(TOPIC, message)).resolves.toBeNull();
        expect(bus.handlerErrors).toHaveLength(1);
        expect(log.get(message.messageId)).toBeUndefined();

        await expect(bus.publishRaw(TOPIC, message)).resolves.toBe('processed');
        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('keeps a message published to a topic nobody subscribed to', async () => {
        const message = validMessage();

        await bus.publish('dispatch.sync.requested', message);

        expect(bus.publishedTo('dispatch.sync.requested')).toEqual([message]);
    });

    it('rejects a subscription to a topic outside the catalog', async () => {
        await expect(bus.subscribe('unknown.topic.name', handler)).rejects.toThrow(UnknownTopicException);
    });

    it('allows one handler per topic', async () => {
        await expect(bus.subscribe(TOPIC, handler)).rejects.toThrow(TopicAlreadySubscribedException);
    });
});

describe('MessagingModule (memory adapter)', () => {
    it('provides the MessageBus port', async () => {
        process.env.MESSAGING_CONTRACTS_DIR = CONTRACTS_DIR;
        const moduleRef = await Test.createTestingModule({
            imports: [MessagingModule.register('memory')],
        }).compile();

        expect(moduleRef.get(MessageBus)).toBeInstanceOf(MemoryMessageBusAdapter);
        delete process.env.MESSAGING_CONTRACTS_DIR;
    });

    it('fails fast with an unknown adapter', () => {
        expect(() => MessagingModule.register('kafka' as never)).toThrow('Unknown MESSAGING_ADAPTER');
    });
});
