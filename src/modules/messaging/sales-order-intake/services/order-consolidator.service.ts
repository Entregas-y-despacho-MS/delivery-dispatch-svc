import { Injectable, Logger } from '@nestjs/common';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { OrderSyncStatePort } from '../../sales-order-sync/ports/order-sync-state.port.js';
import type { ConsolidatedOrder } from '../domain/consolidated-order.types.js';
import { evaluateConsolidation, type ConsolidationDecision } from '../domain/evaluate-consolidation.js';
import { ConsolidationRecord } from '../ports/consolidation-record.port.js';
import { DispatchGenerator } from '../ports/dispatch-generator.port.js';
import { ShipmentBlocksReader } from '../ports/shipment-blocks.reader.js';
import { MarketplaceOrderRepository } from '../repositories/marketplace-order.repository.js';

export type ConsolidationResult =
    | { status: 'consolidated'; dispatchId: number; order: ConsolidatedOrder }
    | { status: 'already_consolidated'; dispatchId: number }
    | Exclude<ConsolidationDecision, { status: 'ready' }>;

/**
 * The unifier of the two sources of a sales order (ST-72.2). Both consumers (Marketplace here,
 * Almacén in ST-72.1) call it **after** saving their own data, inside the same transaction
 * (`options.manager`), which already holds the lock of the order.
 *
 * When both bases are there, nothing is cancelled and the shipment is ready, it hands the joined
 * order to the dispatch generator (`ST-49.1`) and marks both sides as consolidated, so a later
 * call does nothing. Otherwise it only reports why it did not create anything.
 */
@Injectable()
export class OrderConsolidator {
    private readonly logger = new Logger(OrderConsolidator.name);

    constructor(
        private readonly syncStates: OrderSyncStatePort,
        private readonly orders: MarketplaceOrderRepository,
        private readonly shipments: ShipmentBlocksReader,
        private readonly generator: DispatchGenerator,
        private readonly record: ConsolidationRecord,
    ) {}

    async tryConsolidate(salesOrderId: string, options: TransactionOptions): Promise<ConsolidationResult> {
        const existing = await this.record.find(salesOrderId, options);
        if (existing) return { status: 'already_consolidated', dispatchId: existing.dispatchId };

        const marketplace = await this.orders.find(salesOrderId, options);
        const inventory = await this.syncStates.find(salesOrderId, 'inventory', options);
        // The blocks of Almacén are only read once its base arrived.
        const shipment = inventory?.baseReceived ? await this.shipments.find(salesOrderId, options) : null;

        const decision = evaluateConsolidation({ marketplace, inventory, shipment });
        if (decision.status !== 'ready') {
            if (decision.status === 'inconsistent') {
                this.logger.error(`Order ${salesOrderId} cannot be consolidated: ${decision.detail}.`);
            }
            return decision;
        }

        const created = await this.generator.createFromConsolidated(decision.order, options);
        await this.record.mark(salesOrderId, { dispatchId: created.dispatchId, consolidatedAt: new Date() }, options);

        this.logger.log(`Order ${salesOrderId} consolidated into dispatch ${created.dispatchId}.`);
        return { status: 'consolidated', dispatchId: created.dispatchId, order: decision.order };
    }
}
