import { Logger } from '@nestjs/common';
import { buildDeadLetterPayload, deadLetterTopicFor, type DeadLetterPayload } from './dead-letter.js';
import type { MessageEnvelope } from './envelope/message-envelope.js';
import type { MessageValidator } from './envelope/message-validator.js';
import type { InboundMessageLog } from './inbound-message-log.port.js';
import type { MessageHandler } from './message-bus.port.js';

export type ConsumeOutcome = 'processed' | 'duplicate' | 'rejected';

/** Publishes a payload to a dead-letter topic; each adapter provides its own transport. */
export type DeadLetterPublisher = (deadLetterTopic: string, payload: DeadLetterPayload) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VARCHAR = 100;
const UNKNOWN_SOURCE = 'unknown';

/**
 * Receive pipeline shared by every adapter: ignore repeated messages, validate against the schema
 * of the topic, send invalid ones to the dead-letter and hand valid ones to the handler.
 * A transactional handler commits its own receipt and returns `receipt-committed`. Legacy handlers
 * are recorded after they succeed. A failing handler is retried by the broker.
 */
export class MessageConsumer {
    private readonly logger = new Logger(MessageConsumer.name);
    /** Tail of the work in progress per messageId, so two deliveries of the same message never overlap. */
    private readonly inFlight = new Map<string, Promise<void>>();

    constructor(
        private readonly validator: MessageValidator,
        private readonly log: InboundMessageLog,
        private readonly publishDeadLetter: DeadLetterPublisher,
    ) {}

    async consume(topic: string, message: unknown, handler: MessageHandler): Promise<ConsumeOutcome> {
        const messageId = this.messageIdOf(message);
        if (!messageId) return await this.process(topic, message, handler, null);

        // Pub/Sub may deliver the same message twice at once: the second delivery waits for the
        // first and then finds its receipt, instead of running the handler a second time.
        const previous = this.inFlight.get(messageId) ?? Promise.resolve();
        const run = previous.then(() => this.process(topic, message, handler, messageId));
        const tail = run.then(
            () => undefined,
            () => undefined,
        );
        this.inFlight.set(messageId, tail);
        try {
            return await run;
        } finally {
            if (this.inFlight.get(messageId) === tail) this.inFlight.delete(messageId);
        }
    }

    private async process(
        topic: string,
        message: unknown,
        handler: MessageHandler,
        messageId: string | null,
    ): Promise<ConsumeOutcome> {
        if (messageId && (await this.log.wasProcessed(messageId))) {
            this.logger.debug(`Ignored repeated message ${messageId} on ${topic}.`);
            return 'duplicate';
        }

        const result = this.validator.validate(topic, message);
        if (!result.valid) {
            await this.publishDeadLetter(
                deadLetterTopicFor(topic),
                buildDeadLetterPayload(topic, message, result.errors),
            );
            if (messageId) {
                await this.log.record({
                    messageId,
                    status: 'rejected',
                    type: topic,
                    source: this.sourceOf(message),
                    errorDetail: JSON.stringify(result.errors),
                });
            }
            this.logger.warn(`Rejected message ${messageId ?? '(no id)'} on ${topic}: ${result.errors.length} error(s).`);
            return 'rejected';
        }

        const envelope = message as MessageEnvelope;
        const handlingResult = await handler(envelope);
        if (handlingResult === 'duplicate') return 'duplicate';
        if (handlingResult !== 'receipt-committed') {
            await this.log.record({
                messageId: envelope.messageId,
                status: 'processed',
                type: envelope.type,
                source: envelope.source,
            });
        }
        return 'processed';
    }

    /** Only a well-formed UUID can be stored as `message_id`. */
    private messageIdOf(message: unknown): string | null {
        const id = (message as { messageId?: unknown } | null)?.messageId;
        return typeof id === 'string' && UUID.test(id) ? id : null;
    }

    private sourceOf(message: unknown): string {
        const source = (message as { source?: unknown } | null)?.source;
        return typeof source === 'string' && source.length > 0 ? source.slice(0, MAX_VARCHAR) : UNKNOWN_SOURCE;
    }
}
