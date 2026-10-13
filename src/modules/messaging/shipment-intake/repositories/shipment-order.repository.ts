import { Injectable } from '@nestjs/common';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { OrderSyncStatePort } from '../../sales-order-sync/ports/order-sync-state.port.js';
import type { ShipmentState } from '../domain/shipment-message.types.js';
import { PendingShipmentStore } from '../ports/pending-shipment.store.js';

/**
 * Inventory state lives in two rows: the per-origin version and cancellation in
 * `sales_order_sync_states`, and the merged data blocks in `pending_shipments`.
 * Both writes receive the same manager as the inbound receipt.
 */
@Injectable()
export class ShipmentOrderRepository {
    constructor(
        private readonly syncStates: OrderSyncStatePort,
        private readonly pending: PendingShipmentStore,
    ) {}

    async find(salesOrderId: string, options?: MutationOptions): Promise<ShipmentState | null> {
        const sync = await this.syncStates.find(salesOrderId, 'inventory', options);
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

        // Migration 014 backfills older Inventory rows with base_received = FALSE. No consumer
        // wrote those rows yet, but the fallback keeps the same conservative interpretation.
        return {
            salesOrderId,
            lastRecordVersion: pending!.recordVersion,
            baseReceived: false,
            cancelledAt: null,
            cancelledVersion: null,
            blocks: pending!.blocks,
        };
    }

    async save(state: ShipmentState, options?: MutationOptions): Promise<void> {
        await this.syncStates.save({
            salesOrderId: state.salesOrderId,
            source: 'inventory',
            lastRecordVersion: state.lastRecordVersion,
            baseReceived: state.baseReceived,
            cancelledAt: state.cancelledAt,
            cancelledVersion: state.cancelledVersion,
        }, options);
        await this.pending.save({
            salesOrderId: state.salesOrderId,
            recordVersion: state.lastRecordVersion,
            blocks: state.blocks,
        }, options);
    }
}
