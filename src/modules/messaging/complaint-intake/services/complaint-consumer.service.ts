import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { COMPLAINT_OPENED_TOPIC, type DeliveryComplaintOpenedData } from '../domain/complaint-message.types.js';
import { ComplaintIntakeService, type ComplaintIntakeResult } from './complaint-intake.service.js';

/**
 * Consumes `crm.delivery_complaint.opened` (ST-298.3). The message is already validated against its
 * schema and deduplicated by `messageId` when the handler runs. Business rejections are not errors:
 * they commit the receipt and queue a `rejected` acknowledgement, so the broker does not redeliver.
 * A persistence error throws and rolls the whole transaction back.
 */
@Injectable()
export class ComplaintConsumer implements OnModuleInit {
    private readonly logger = new Logger(ComplaintConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly intake: ComplaintIntakeService,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(COMPLAINT_OPENED_TOPIC, (envelope) => this.handle(envelope));
    }

    private async handle(envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const data = envelope.data as unknown as DeliveryComplaintOpenedData;
        let outcome: ComplaintIntakeResult | undefined;

        // One case is processed at a time across instances: the key is its functional key.
        const result = await this.transaction.process(
            envelope,
            `crm-case:${envelope.source}:${data.crmCaseId}`,
            async (options) => {
                outcome = await this.intake.apply(envelope, data, options);
            },
        );

        if (result === 'duplicate') {
            this.logger.debug(`Ignored repeated complaint message ${envelope.messageId}.`);
            return result;
        }
        this.logOutcome(data, outcome);
        return result;
    }

    private logOutcome(data: DeliveryComplaintOpenedData, outcome: ComplaintIntakeResult | undefined): void {
        const label = `complaint ${data.crmCaseId} v${data.caseVersion}`;
        if (!outcome || outcome.status === 'ignored') {
            this.logger.debug(`Ignored ${label}: the case already holds this version or a newer one.`);
        } else if (outcome.status === 'accepted') {
            this.logger.debug(`Accepted ${label} for dispatch ${outcome.dispatchId}.`);
        } else {
            this.logger.warn(`Rejected ${label}: ${outcome.code}.`);
        }
    }
}
