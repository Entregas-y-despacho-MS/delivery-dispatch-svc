import type { MutationOptions } from '../../../../shared/dto/options.dto.js';

/** Origins whose messages are joined by `salesOrderId`. */
export type OrderSyncSource = 'marketplace' | 'inventory' | 'procurement';

/**
 * What is remembered per sales order and per origin, before and after the order becomes a dispatch
 * (table `sales_order_sync_states`, migration 014). It is the single source of truth of the
 * version of each origin: the rows of `pending_*` only keep the blocks.
 */
export interface OrderSyncState {
    salesOrderId: string;
    source: OrderSyncSource;
    /** Last `recordVersion` applied for this origin. `0` means nothing was received yet. */
    lastRecordVersion: number;
    /** `true` once the base message (`confirmed` / `ready`) of this origin was applied. */
    baseReceived: boolean;
    /** ISO-8601 UTC; set by a cancellation, terminal for this origin. */
    cancelledAt: string | null;
    cancelledVersion: number | null;
}

/**
 * Port of the per-order, per-origin sync state. Both consumers (Marketplace in ST-72.2, Almacén in
 * ST-72.1) and `tryConsolidate` use it. Every method takes `{ manager }` so it runs inside the
 * transaction opened by `InboundMessageTransaction.process`.
 *
 * `save` is an upsert of the fields above only: columns that belong to other features (the recovery
 * counters of ST-50.5) must be left untouched by an adapter.
 */
export abstract class OrderSyncStatePort {
    /** The state of one origin, or `null` if no row exists yet. */
    abstract find(
        salesOrderId: string,
        source: OrderSyncSource,
        options?: MutationOptions,
    ): Promise<OrderSyncState | null>;

    /** The states of every origin that has a row for the order (zero, one or two). */
    abstract findAllOf(salesOrderId: string, options?: MutationOptions): Promise<OrderSyncState[]>;

    /** Creates or updates the row of (`salesOrderId`, `source`). */
    abstract save(state: OrderSyncState, options?: MutationOptions): Promise<void>;
}
