import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

/**
 * Outbox: messages Despachos must publish to the ERP. A row is written in the same transaction as
 * the event that produces it and published afterwards, so a broker failure never blocks the operation.
 */
@Entity('outbound_messages')
export class OutboundMessage extends BaseCreatedUpdated {
    // Same UUID v7 as `payload.messageId`: the consumers deduplicate by it.
    @PrimaryColumn({ name: 'message_id', type: 'uuid' })
    messageId: string;

    // pending | sent | failed (catalog outbound_message_statuses). `sent` and `failed` are terminal.
    @Column({ name: 'status', type: 'varchar', length: 20 })
    status: string;

    // Event type; it is also the topic the message is published to.
    @Column({ name: 'type', type: 'varchar', length: 100 })
    type: string;

    // The whole message envelope, exactly as it will be published.
    @Column({ name: 'payload', type: 'jsonb' })
    payload: Record<string, unknown>;

    @Column({ name: 'attempts', type: 'int' })
    attempts: number;

    @Column({ name: 'next_attempt_at', type: 'timestamptz' })
    nextAttemptAt: Date;
}
