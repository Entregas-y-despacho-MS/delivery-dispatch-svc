import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import type { MarketplaceOrderBlocks } from '../domain/marketplace-order.types.js';

/** The Marketplace blocks stored for one sales order (row of `pending_sales_orders`). */
export interface PendingSalesOrderRecord {
    salesOrderId: string;
    /** Informational copy of the last version applied; the sync state rules idempotency. */
    recordVersion: number;
    blocks: MarketplaceOrderBlocks;
}

/** Port of the storage of the Marketplace blocks of an order. */
export abstract class PendingSalesOrderStore {
    abstract find(salesOrderId: string, options?: MutationOptions): Promise<PendingSalesOrderRecord | null>;

    /** Creates or replaces the row. The stored `recordVersion` never goes down. */
    abstract save(record: PendingSalesOrderRecord, options?: MutationOptions): Promise<void>;
}
