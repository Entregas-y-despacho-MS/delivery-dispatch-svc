import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

/**
 * Append-only receipt log of incoming messages. The broker's message UUID is the primary key, which
 * is what makes a repeated delivery detectable (idempotency by `messageId`).
 */
@Entity('inbound_messages')
export class InboundMessage extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'message_id', type: 'uuid' })
    messageId: string;

    // processed | rejected (catalog inbound_message_statuses)
    @Column({ name: 'status', type: 'varchar', length: 20 })
    status: string;

    @Column({ name: 'type', type: 'varchar', length: 100 })
    type: string;

    // marketplace | inventory | procurement (or `unknown` for a rejected message without a valid source)
    @Column({ name: 'source', type: 'varchar', length: 100 })
    source: string;

    @Column({ name: 'received_at', type: 'timestamptz' })
    receivedAt: Date;

    // Required when status = rejected (CHECK in the database); NULL when processed.
    @Column({ name: 'error_detail', type: 'text', nullable: true })
    errorDetail: string | null;
}
