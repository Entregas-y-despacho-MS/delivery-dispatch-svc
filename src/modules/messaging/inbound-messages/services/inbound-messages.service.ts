import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InboundMessageLog, type InboundMessageRecord } from '../../../../plugins/messaging/inbound-message-log.port.js';
import { InboundMessage } from '../entities/inbound-message.entity.js';

const MAX_VARCHAR = 100;

/**
 * Receipt log of incoming messages on top of `inbound_messages`. It is the adapter of the
 * `InboundMessageLog` port: the messaging plugin asks it whether a `messageId` was already processed.
 */
@Injectable()
export class InboundMessagesService extends InboundMessageLog {
    constructor(
        @InjectRepository(InboundMessage) private readonly rawRepo: Repository<InboundMessage>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async wasProcessed(messageId: string): Promise<boolean> {
        return await this.rawRepo.existsBy({ messageId, status: 'processed' });
    }

    /**
     * The primary key decides: with two instances receiving the same message at once, exactly one
     * insert wins and the other gets `false` back. The only row that is overwritten is a `rejected`
     * receipt replaced by a `processed` one (the sender corrected the message and resent it).
     */
    async record(record: InboundMessageRecord): Promise<boolean> {
        const rows: { message_id: string }[] = await this.dataSource.query(
            `INSERT INTO inbound_messages (message_id, status, type, source, error_detail)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (message_id) DO UPDATE
                SET status = EXCLUDED.status, type = EXCLUDED.type, source = EXCLUDED.source,
                    error_detail = NULL, received_at = NOW(), updated_at = NOW()
              WHERE inbound_messages.status = 'rejected' AND EXCLUDED.status = 'processed'
             RETURNING message_id`,
            [
                record.messageId,
                record.status,
                record.type.slice(0, MAX_VARCHAR),
                record.source.slice(0, MAX_VARCHAR),
                record.status === 'rejected' ? (record.errorDetail ?? 'Rejected.') : null,
            ],
        );
        return rows.length > 0;
    }
}
