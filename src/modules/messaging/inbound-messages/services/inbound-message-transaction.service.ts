import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import {
    InboundMessageTransaction,
    type TransactionalMessageResult,
    type TransactionOptions,
} from '../../../../plugins/messaging/inbound-message-transaction.port.js';

/**
 * Shared unit of work for ERP consumers. It serializes messages for the same sales order across
 * backend instances and commits the business write together with the processed receipt.
 */
@Injectable()
export class InboundMessageTransactionService extends InboundMessageTransaction {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async process(
        envelope: MessageEnvelope,
        salesOrderId: string,
        handle: (options: TransactionOptions) => Promise<void>,
    ): Promise<TransactionalMessageResult> {
        return await this.dataSource.transaction<TransactionalMessageResult>(async (manager) => {
            // Lock the message first and then the order, in the same order in every consumer.
            // The message lock also covers a corrected resend with the same messageId.
            await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
                `inbound-message:${envelope.messageId}`,
            ]);
            await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
                `sales-order:${salesOrderId}`,
            ]);

            const existing: { status: string }[] = await manager.query(
                'SELECT status FROM inbound_messages WHERE message_id = $1 FOR UPDATE',
                [envelope.messageId],
            );
            if (existing[0]?.status === 'processed') return 'duplicate';

            await handle({ manager });
            await manager.query(
                `INSERT INTO inbound_messages (message_id, status, type, source, error_detail)
                 VALUES ($1, 'processed', $2, $3, NULL)
                 ON CONFLICT (message_id) DO UPDATE
                    SET status = 'processed', type = EXCLUDED.type, source = EXCLUDED.source,
                        error_detail = NULL, received_at = NOW(), updated_at = NOW()
                  WHERE inbound_messages.status = 'rejected'`,
                [envelope.messageId, envelope.type, envelope.source],
            );
            return 'receipt-committed';
        });
    }
}
