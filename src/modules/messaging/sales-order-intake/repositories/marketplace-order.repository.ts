import { Injectable } from '@nestjs/common';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { OrderSyncStatePort } from '../../sales-order-sync/ports/order-sync-state.port.js';
import type { MarketplaceOrderState } from '../domain/marketplace-order.types.js';
import { PendingSalesOrderStore } from '../ports/pending-sales-order.store.js';

/**
 * The Marketplace state of one sales order, assembled from its two homes: the version, the base
 * mark and the cancellation live in the sync state (shared with Almacén), the blocks live in
 * `pending_sales_orders`. Both are written together; the caller passes `{ manager }` from
 * `SalesOrderLock.withLock` so they commit as one.
 */
@Injectable()
export class MarketplaceOrderRepository {
    constructor(
        private readonly syncStates: OrderSyncStatePort,
        private readonly pending: PendingSalesOrderStore,
    ) {}

    /** The state of the order, or `null` if nothing from Marketplace was ever stored. */
    async find(salesOrderId: string, options?: MutationOptions): Promise<MarketplaceOrderState | null> {
        const sync = await this.syncStates.find(salesOrderId, 'marketplace', options);
        const pending = await this.pending.find(salesOrderId, options);

        if (!sync && !pending) return null;

        if (sync) {
            return {
                salesOrderId,
                lastRecordVersion: sync.lastRecordVersion,
                baseReceived: sync.baseReceived,
                cancelledAt: sync.cancelledAt,
                cancelledVersion: sync.cancelledVersion,
                blocks: pending?.blocks ?? {},
            };
        }

        // A row without sync state predates it: the base is known from the payload, because only
        // `confirmed` carries `confirmedAt` (the same rule as the backfill of migration 014).
        return {
            salesOrderId,
            lastRecordVersion: pending!.recordVersion,
            baseReceived: pending!.blocks.confirmedAt !== undefined,
            cancelledAt: null,
            cancelledVersion: null,
            blocks: pending!.blocks,
        };
    }

    async save(state: MarketplaceOrderState, options?: MutationOptions): Promise<void> {
        await this.syncStates.save(
            {
                salesOrderId: state.salesOrderId,
                source: 'marketplace',
                lastRecordVersion: state.lastRecordVersion,
                baseReceived: state.baseReceived,
                cancelledAt: state.cancelledAt,
                cancelledVersion: state.cancelledVersion,
            },
            options,
        );
        await this.pending.save(
            { salesOrderId: state.salesOrderId, recordVersion: state.lastRecordVersion, blocks: state.blocks },
            options,
        );
    }
}
