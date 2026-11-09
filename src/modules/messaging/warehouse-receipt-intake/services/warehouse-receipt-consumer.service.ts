import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { DISPATCH_CHANGE_REQUIRES_ATTENTION } from '../../sales-order-intake/services/dispatch-change-events.service.js';
import type { InventoryReceiptConfirmedData } from '../domain/warehouse-receipt-message.types.js';
import { WarehouseReceiptIntakeService, type ApplyReceiptResult } from './warehouse-receipt-intake.service.js';

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
        const data = envelope.data as unknown as InventoryReceiptConfirmedData;
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
            this.emitOrphan(outcome.dispatchId, outcome.referenceId);
        } else {
            this.logger.debug(`Receipt ${data.receiptId} applied: dispatch ${outcome.dispatchId} -> ${outcome.newStatus}.`);
        }

        return result;
    }

    private emitOrphan(dispatchId: number | null, referenceId: string): void {
        try {
            this.events.emit(DISPATCH_CHANGE_REQUIRES_ATTENTION, {
                dispatchId: dispatchId ?? undefined,
                salesOrderId: dispatchId === null ? referenceId : undefined,
                source: 'inventory',
                changeType: 'orphan_receipt',
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
