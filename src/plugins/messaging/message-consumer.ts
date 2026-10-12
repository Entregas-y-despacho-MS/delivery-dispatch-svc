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
 * The receipt of a valid message is stored only after the handler succeeds, so a failing handler
 * is retried by the broker instead of being lost.
 */
export class MessageConsumer {
    private readonly logger = new Logger(MessageConsumer.name);

    constructor(
        private readonly validator: MessageValidator,
        private readonly log: InboundMessageLog,
        private readonly publishDeadLetter: DeadLetterPublisher,
    ) {}

    async consume(topic: string, message: unknown, handler: MessageHandler): Promise<ConsumeOutcome> {
        const messageId = this.messageIdOf(message);

        if (messageId && (await this.log.exists(messageId))) {
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
        await handler(envelope);
        await this.log.record({
            messageId: envelope.messageId,
            status: 'processed',
            type: envelope.type,
            source: envelope.source,
        });
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
