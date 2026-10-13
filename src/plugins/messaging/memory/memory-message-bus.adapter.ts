import { Injectable, Logger, Optional } from '@nestjs/common';
import { deadLetterTopicFor, type DeadLetterPayload } from '../dead-letter.js';
import type { MessageEnvelope } from '../envelope/message-envelope.js';
import { MessageValidator } from '../envelope/message-validator.js';
import { TopicAlreadySubscribedException, UnknownTopicException } from '../exceptions/index.js';
import { InboundMessageLog } from '../inbound-message-log.port.js';
import { InboundMessageRejection } from '../inbound-message-rejection.port.js';
import { MessageBus, type MessageHandler } from '../message-bus.port.js';
import { MessageConsumer, type ConsumeOutcome } from '../message-consumer.js';

export interface PublishedMessage {
    topic: string;
    payload: unknown;
}

/**
 * In-process message bus for tests and local runs without Docker. Delivery is synchronous: when
 * `publish` resolves, the subscribed handler already ran. It mimics the broker: a handler error is
 * not thrown to the publisher; it is kept in `handlerErrors` and the message is not marked as processed.
 */
@Injectable()
export class MemoryMessageBusAdapter extends MessageBus {
    private readonly logger = new Logger(MemoryMessageBusAdapter.name);
    private readonly handlers = new Map<string, MessageHandler>();
    private readonly consumer: MessageConsumer;

    /** Everything published, in order, including dead-letter payloads. */
    readonly published: PublishedMessage[] = [];
    /** Errors thrown by handlers (the broker would redeliver those messages). */
    readonly handlerErrors: { topic: string; error: unknown }[] = [];

    constructor(
        private readonly validator: MessageValidator,
        inboundLog: InboundMessageLog,
        @Optional() inboundRejection?: InboundMessageRejection,
    ) {
        super();
        this.consumer = new MessageConsumer(
            validator,
            inboundLog,
            async (topic, payload) => {
                this.published.push({ topic, payload });
            },
            inboundRejection,
        );
    }

    async publish(topic: string, envelope: MessageEnvelope): Promise<void> {
        await this.publishRaw(topic, envelope);
    }

    /**
     * Test helper: publishes anything as if it came from another service, e.g. a malformed message.
     * Returns what the pipeline did with it, or `null` when nobody is subscribed or the handler failed.
     */
    async publishRaw(topic: string, payload: unknown): Promise<ConsumeOutcome | null> {
        this.published.push({ topic, payload });
        const handler = this.handlers.get(topic);
        if (!handler) return null;

        try {
            return await this.consumer.consume(topic, payload, handler);
        } catch (error) {
            this.handlerErrors.push({ topic, error });
            this.logger.warn(`Handler of ${topic} failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    async subscribe(topic: string, handler: MessageHandler): Promise<void> {
        if (!this.validator.hasTopic(topic)) throw new UnknownTopicException(topic);
        if (this.handlers.has(topic)) throw new TopicAlreadySubscribedException(topic);
        this.handlers.set(topic, handler);
    }

    /** Test helper: payloads published to a topic. */
    publishedTo(topic: string): unknown[] {
        return this.published.filter((entry) => entry.topic === topic).map((entry) => entry.payload);
    }

    /** Test helper: dead-letter payloads of a topic. */
    deadLettersOf(topic: string): DeadLetterPayload[] {
        return this.publishedTo(deadLetterTopicFor(topic)) as DeadLetterPayload[];
    }

    /** Test helper. */
    reset(): void {
        this.published.length = 0;
        this.handlerErrors.length = 0;
    }
}
