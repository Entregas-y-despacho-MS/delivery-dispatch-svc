import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { buildEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import {
    INBOUND_MESSAGE_REJECTED_EVENT,
    type InboundRejectionNotice,
} from '../../../../plugins/messaging/inbound-message-rejection.port.js';
import { InvalidOutboundMessageException } from '../../outbound-messages/exceptions/index.js';
import { OutboxService } from '../../outbound-messages/services/outbox.service.js';
import { COMPLAINT_OPENED_TOPIC, COMPLAINT_REJECTED_TOPIC } from '../domain/complaint-message.types.js';

const MAX_FIELD_LENGTH = 200;

interface CorrelationHints {
    crmCaseId?: string;
    caseVersion?: number;
}

/**
 * Answers CRM when a complaint does not even meet the message schema (ST-298.3, escenario 2): the
 * shared consumer has already sent it to the dead-letter, and this queues
 * `dispatch.delivery_complaint.rejected` with `schema_invalid`. Best-effort like the rest of the
 * rejection alert: a failure is thrown to the consumer, which logs it and keeps the dead-letter.
 *
 * A message whose own `messageId` is not usable cannot be correlated, so it gets no acknowledgement.
 */
@Injectable()
export class ComplaintRejectionAcknowledger {
    private readonly logger = new Logger(ComplaintRejectionAcknowledger.name);

    constructor(private readonly outbox: OutboxService) {}

    @OnEvent(INBOUND_MESSAGE_REJECTED_EVENT)
    async onInboundMessageRejected(notice: InboundRejectionNotice): Promise<void> {
        if (notice.type !== COMPLAINT_OPENED_TOPIC || notice.reasonCode !== 'schema_invalid') return;

        const original = notice.message as { messageId?: unknown; data?: unknown } | null | undefined;
        // `notice.messageId` is a fresh ID when the original was unusable; only the original correlates.
        if (typeof original?.messageId !== 'string' || original.messageId !== notice.messageId) {
            this.logger.warn(`No acknowledgement for an invalid complaint without a usable messageId (${notice.messageId}).`);
            return;
        }

        const hints = this.hintsOf(original.data);
        const field = notice.errors[0]?.path.slice(0, MAX_FIELD_LENGTH);
        try {
            await this.enqueue(notice, hints, field);
        } catch (error) {
            if (!(error instanceof InvalidOutboundMessageException) || hints.crmCaseId === undefined) throw error;
            // An unreadable crmCaseId/caseVersion must not cost CRM its answer: send it without them.
            await this.enqueue(notice, {}, field);
        }
    }

    private async enqueue(notice: InboundRejectionNotice, hints: CorrelationHints, field: string | undefined): Promise<void> {
        await this.outbox.enqueue(
            buildEnvelope({
                type: COMPLAINT_REJECTED_TOPIC,
                source: 'dispatch',
                occurredAt: new Date(notice.rejectedAt),
                data: {
                    correlationMessageId: notice.messageId,
                    ...hints,
                    rejectionCode: 'schema_invalid',
                    ...(field ? { field } : {}),
                    rejectedAt: notice.rejectedAt,
                },
            }),
        );
    }

    /** `crmCaseId` and `caseVersion` only when the payload carries them in a readable form. */
    private hintsOf(data: unknown): CorrelationHints {
        const { crmCaseId, caseVersion } = (data ?? {}) as { crmCaseId?: unknown; caseVersion?: unknown };
        if (typeof crmCaseId !== 'string' || crmCaseId.length === 0) return {};
        return {
            crmCaseId,
            ...(Number.isInteger(caseVersion) && (caseVersion as number) >= 1 ? { caseVersion: caseVersion as number } : {}),
        };
    }
}
