import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    InboundMessageRejection,
    type InboundRejectionNotice,
} from '../../../../plugins/messaging/inbound-message-rejection.port.js';

const AUDIT_ACTION = 'inbound_message_rejected';
const DOMAIN_EVENT = 'integration.message_rejected';
const MAX_AUDIT_ERRORS = 20;
const MAX_ERROR_TEXT = 200;

/** Persists a rejection alert before announcing it to the socket integration layer. */
@Injectable()
export class AuditInboundMessageRejectionAdapter extends InboundMessageRejection {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly events: EventEmitter2,
    ) {
        super();
    }

    async notify(notice: InboundRejectionNotice): Promise<void> {
        const errors = notice.errors.slice(0, MAX_AUDIT_ERRORS).map((error) => ({
            path: error.path.slice(0, MAX_ERROR_TEXT),
            keyword: error.keyword.slice(0, MAX_ERROR_TEXT),
            message: error.message.slice(0, MAX_ERROR_TEXT),
        }));
        await this.dataSource.query(
            'INSERT INTO audit_logs (user_id, action, detail) VALUES (NULL, $1, $2)',
            [AUDIT_ACTION, JSON.stringify({
                messageId: notice.messageId,
                type: notice.type,
                source: notice.source,
                reasonCode: notice.reasonCode,
                errors,
            })],
        );
        const { messageId, type, source, salesOrderId, reasonCode, rejectedAt } = notice;
        this.events.emit(DOMAIN_EVENT, {
            messageId,
            type,
            source,
            ...(salesOrderId !== undefined ? { salesOrderId } : {}),
            reasonCode,
            rejectedAt,
        });
    }
}
