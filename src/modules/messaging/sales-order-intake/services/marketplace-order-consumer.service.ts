import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { applyMarketplaceMessage, type ApplyOutcome } from '../domain/apply-marketplace-message.js';
import type {
    CancelledOrderData,
    ConfirmedOrderData,
    MarketplaceOrderMessage,
    UpdatedOrderData,
} from '../domain/marketplace-order.types.js';
import { MarketplaceOrderRepository } from '../repositories/marketplace-order.repository.js';

export const MARKETPLACE_ORDER_TOPICS = {
    confirmed: 'marketplace.sales_order.confirmed',
    updated: 'marketplace.sales_order.updated',
    cancelled: 'marketplace.sales_order.cancelled',
} as const;

/**
 * Consumer of the delivery data that Marketplace sends for a sales order (ST-72.2).
 *
 * By the time a handler runs, the message already passed the JSON Schema of its topic
 * (`MessageConsumer`), so `envelope.data` has the shape of the contract. Each message is applied to the
 * Marketplace state of its order inside `InboundMessageTransaction`: the state and the `processed`
 * receipt commit together, and a repeated message does not run the handler again.
 *
 * Joining with Almacén (`tryConsolidate`) and the changes over an existing dispatch come in the
 * next stages of the subtask.
 */
@Injectable()
export class MarketplaceOrderConsumer implements OnModuleInit {
    private readonly logger = new Logger(MarketplaceOrderConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly orders: MarketplaceOrderRepository,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(MARKETPLACE_ORDER_TOPICS.confirmed, (envelope) =>
            this.handle({ kind: 'confirmed', data: envelope.data as unknown as ConfirmedOrderData }, envelope),
        );
        await this.bus.subscribe(MARKETPLACE_ORDER_TOPICS.updated, (envelope) =>
            this.handle({ kind: 'updated', data: envelope.data as unknown as UpdatedOrderData }, envelope),
        );
        await this.bus.subscribe(MARKETPLACE_ORDER_TOPICS.cancelled, (envelope) =>
            this.handle({ kind: 'cancelled', data: envelope.data as unknown as CancelledOrderData }, envelope),
        );
    }

    private async handle(message: MarketplaceOrderMessage, envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const { salesOrderId } = message.data;
        let outcome: ApplyOutcome | undefined;

        const result = await this.transaction.process(envelope, salesOrderId, async (options) => {
            const current = await this.orders.find(salesOrderId, options);
            const applied = applyMarketplaceMessage(current, message);
            outcome = applied.outcome;

            // An ignored message changes nothing: only its receipt is committed.
            if (applied.outcome === 'applied' || applied.outcome === 'base_completed_late') {
                await this.orders.save(applied.state, options);
            }
        });

        if (result === 'duplicate') {
            this.logger.debug(`Ignored repeated message ${envelope.messageId} of order ${salesOrderId}.`);
        } else {
            this.logger.debug(`${envelope.type} of order ${salesOrderId}: ${outcome}.`);
        }
        return result;
    }
}
