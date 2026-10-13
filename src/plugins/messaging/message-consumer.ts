import { Logger } from '@nestjs/common';
import { buildDeadLetterPayload, deadLetterTopicFor, type DeadLetterPayload } from './dead-letter.js';
import type { MessageEnvelope } from './envelope/message-envelope.js';
import type { MessageValidationError, MessageValidator } from './envelope/message-validator.js';
import { generateMessageId } from './envelope/uuid-v7.js';
import { RejectedMessageException } from './exceptions/rejected-message.exception.js';
import type { InboundMessageLog } from './inbound-message-log.port.js';
import type { InboundMessageRejection, InboundRejectionReasonCode } from './inbound-message-rejection.port.js';
import type { MessageHandler } from './message-bus.port.js';

export type ConsumeOutcome = 'processed' | 'duplicate' | 'rejected';

/** Publishes a payload to a dead-letter topic; each adapter provides its own transport. */
export type DeadLetterPublisher = (deadLetterTopic: string, payload: DeadLetterPayload) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VARCHAR = 100;
const UNKNOWN_SOURCE = 'unknown';
const KNOWN_SOURCES = new Set(['marketplace', 'inventory', 'procurement', 'dispatch']);

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
        private readonly rejection?: InboundMessageRejection,
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
            return await this.reject(topic, message, messageId, result.errors, 'schema_invalid');
        }

        const envelope = message as MessageEnvelope;
        let handlingResult;
        try {
            handlingResult = await handler(envelope);
        } catch (error) {
            if (!(error instanceof RejectedMessageException)) throw error;
            return await this.reject(topic, message, messageId, error.errors, error.reasonCode);
        }
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

    private async reject(
        topic: string,
        message: unknown,
        messageId: string | null,
        errors: MessageValidationError[],
        reasonCode: InboundRejectionReasonCode,
    ): Promise<'rejected'> {
        const deadLetter = buildDeadLetterPayload(topic, message, errors);
        await this.publishDeadLetter(deadLetterTopicFor(topic), deadLetter);

        // An invalid envelope may have no usable UUID. Give its audit/receipt a fresh correlation ID
        // while leaving the original payload untouched in the dead-letter.
        const receiptId = messageId ?? generateMessageId();
        await this.log.record({
            messageId: receiptId,
            status: 'rejected',
            type: topic,
            source: this.sourceOf(message),
            errorDetail: JSON.stringify(errors),
        });

        // Alerting is best-effort. It must not undo either the dead-letter or the rejected receipt.
        const salesOrderId = this.salesOrderIdOf(message);
        try {
            await this.rejection?.notify({
                messageId: receiptId,
                type: topic,
                source: this.sourceOf(message),
                ...(salesOrderId !== undefined ? { salesOrderId } : {}),
                reasonCode,
                rejectedAt: deadLetter.rejectedAt,
                errors,
            });
        } catch (error) {
            this.logger.error(
                `Could not record rejection alert for ${receiptId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        this.logger.warn(`Rejected message ${receiptId} on ${topic}: ${errors.length} error(s).`);
        return 'rejected';
    }

    /** Only a well-formed UUID can be stored as `message_id`. */
    private messageIdOf(message: unknown): string | null {
        const id = (message as { messageId?: unknown } | null)?.messageId;
        return typeof id === 'string' && UUID.test(id) ? id : null;
    }

    private sourceOf(message: unknown): string {
        const source = (message as { source?: unknown } | null)?.source;
        return typeof source === 'string' && KNOWN_SOURCES.has(source) ? source : UNKNOWN_SOURCE;
    }

    private salesOrderIdOf(message: unknown): string | undefined {
        const data = (message as { data?: { salesOrderId?: unknown } } | null)?.data;
        return typeof data?.salesOrderId === 'string' ? data.salesOrderId.slice(0, MAX_VARCHAR) : undefined;
    }
}
