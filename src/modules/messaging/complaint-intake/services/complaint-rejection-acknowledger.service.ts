import { createHash } from 'node:crypto';
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

/**
 * UUID v7-shaped ID derived from the rejected message, so a redelivery of the same invalid message queues
 * the same acknowledgement (`ON CONFLICT (message_id) DO NOTHING`) instead of a new one each time.
 */
export function rejectionMessageIdFor(correlationMessageId: string): string {
    const hex = createHash('sha256').update(`complaint-rejected:${correlationMessageId}`).digest('hex').slice(0, 32).split('');
    hex[12] = '7';
    hex[16] = '89ab'[Number.parseInt(hex[16]!, 16) % 4]!;
    const id = hex.join('');
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

interface CorrelationHints {
    crmCaseId?: string;
    caseVersion?: number;
}

/**
 * Answers CRM when a complaint does not even meet the message schema (ST-298.3, escenario 2): the
 * shared consumer has already sent it to the dead-letter, and this queues
 * `dispatch.delivery_complaint.rejected` with `schema_invalid`. Best-effort like the rest of the
 * rejection alert: it runs after the dead-letter and the `rejected` receipt are written and outside any
 * transaction, and `@OnEvent` swallows (and logs) a listener's error, so a failure here is only a log line
 * and the dead-letter stays. The acknowledgement ID is derived from the rejected message, so a redelivery
 * does not queue a second one.
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
                messageId: rejectionMessageIdFor(notice.messageId),
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
