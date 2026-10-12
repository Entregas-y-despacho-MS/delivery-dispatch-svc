import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import { InvalidOutboundMessageException } from '../exceptions/index.js';

/**
 * Producer side of the outbox. A business service calls `enqueue` inside the same transaction that
 * changes its own data (`{ manager }`), so the message exists if and only if the change committed.
 * Publishing happens later, in `OutboxPublisherService`.
 */
@Injectable()
export class OutboxService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly validator: MessageValidator,
    ) {}

    /**
     * Queues a message for publication. Returns `false` (nothing written) if a message with the
     * same `messageId` was already queued, so a retried business operation never duplicates it.
     * Throws `InvalidOutboundMessageException` when the message does not match the schema of its topic.
     */
    async enqueue(envelope: MessageEnvelope, options?: MutationOptions): Promise<boolean> {
        // Only what Despachos itself publishes goes through the outbox: queuing an incoming topic
        // (`inventory.*`, ...) would publish a forged message to a topic this service also consumes.
        if (envelope.source !== 'dispatch' || !envelope.type.startsWith('dispatch.')) {
            throw new InvalidOutboundMessageException(envelope.type, [
                {
                    path: '/source',
                    message: 'Only messages from source "dispatch" with a "dispatch.*" type can be queued.',
                    keyword: 'outboxScope',
                },
            ]);
        }
        const result = this.validator.validate(envelope.type, envelope);
        if (!result.valid) throw new InvalidOutboundMessageException(envelope.type, result.errors);

        const runner = options?.manager ?? this.dataSource.manager;
        const rows: { message_id: string }[] = await runner.query(
            `INSERT INTO outbound_messages (message_id, type, payload)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (message_id) DO NOTHING
             RETURNING message_id`,
            [envelope.messageId, envelope.type, JSON.stringify(envelope)],
        );
        return rows.length > 0;
    }
}
