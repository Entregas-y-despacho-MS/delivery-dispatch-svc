import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { INCIDENT_REPORTED_EVENT } from '../../../../app/dispatch-incidents/domain/incident-report.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../../../app/dispatch-status/dispatch-status-changed.event.js';
import { DISPATCH_CHANGE_REQUIRES_ATTENTION } from '../../sales-order-intake/services/dispatch-change-events.service.js';
import { toReceiptData } from '../domain/warehouse-receipt-message.types.js';
import { WarehouseReceiptIntakeService, type AppliedReceiptEvents, type ApplyReceiptResult } from './warehouse-receipt-intake.service.js';

export const INVENTORY_RECEIPT_CONFIRMED_TOPIC = 'inventory.receipt.confirmed';

@Injectable()
export class WarehouseReceiptConsumer implements OnModuleInit {
    private readonly logger = new Logger(WarehouseReceiptConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly receipts: WarehouseReceiptIntakeService,
        private readonly events: EventEmitter2,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(INVENTORY_RECEIPT_CONFIRMED_TOPIC, (envelope) => this.handle(envelope));
    }

    private async handle(envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const data = toReceiptData(envelope.data);
        let outcome: ApplyReceiptResult | undefined;

        // Serialize by referenceId (the RMA/purchase order the traslado belongs to), not receiptId: two
        // different receipt messages for the same traslado must not race each other to the same lock
        // that rma-pickup-consumer.service.ts/procurement-pickup-consumer.service.ts already use for it.
        const result = await this.transaction.process(envelope, data.referenceId, async (options) => {
            outcome = await this.receipts.apply(data, options);
        });

        if (result === 'duplicate') {
            this.logger.debug(`Ignored repeated message for receipt ${data.receiptId}.`);
            return result;
        }
        if (!outcome || outcome.status === 'ignored') {
            this.logger.debug(`Ignored receipt ${data.receiptId}: recordVersion ${data.recordVersion} is not newer.`);
            return result;
        }

        if (outcome.status === 'orphan') {
            this.logger.debug(`Receipt ${data.receiptId} is orphan: reference ${outcome.referenceId} did not resolve.`);
            this.emitAttention(outcome.dispatchId, outcome.referenceId, 'orphan_receipt');
        } else if (outcome.status === 'correction') {
            this.logger.debug(`Receipt ${data.receiptId} is a correction on an already-applied receipt (dispatch ${outcome.dispatchId}): left status/dispatch link untouched.`);
            this.emitAttention(outcome.dispatchId, data.referenceId, 'receipt_correction');
        } else {
            this.logger.debug(`Receipt ${data.receiptId} applied: dispatch ${outcome.dispatchId} -> ${outcome.newStatus}.`);
            this.emitApplied(outcome.events);
        }

        return result;
    }

    /** After commit (ST-240.3): coordinators and supervisors see the status and, with differences, the incident. */
    private emitApplied(events: AppliedReceiptEvents): void {
        const emit = (name: string, payload: object): void => {
            try {
                this.events.emit(name, payload);
            } catch (error) {
                // The receipt is already committed; a failing listener must not turn the message into a retry.
                this.logger.error(`A listener of ${name} failed for dispatch ${events.statusChanged.dispatchId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        };
        emit(DISPATCH_STATUS_CHANGED_EVENT, events.statusChanged);
        if (events.incidentReported) emit(INCIDENT_REPORTED_EVENT, events.incidentReported);
    }

    private emitAttention(dispatchId: number | null, referenceId: string, changeType: 'orphan_receipt' | 'receipt_correction'): void {
        try {
            this.events.emit(DISPATCH_CHANGE_REQUIRES_ATTENTION, {
                dispatchId: dispatchId ?? undefined,
                salesOrderId: dispatchId === null ? referenceId : undefined,
                source: 'inventory',
                changeType,
                receivedAt: new Date().toISOString(),
            });
        } catch (error) {
            // The receipt is already committed; a failing listener must not turn the message into a retry.
            this.logger.error(
                `A listener of ${DISPATCH_CHANGE_REQUIRES_ATTENTION} failed for receipt (dispatch ${dispatchId}): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
