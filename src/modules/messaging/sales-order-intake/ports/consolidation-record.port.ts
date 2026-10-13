import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';

export interface ConsolidationMark {
    dispatchId: number;
    consolidatedAt: Date;
}

/**
 * Port to the mark that says an order already became a dispatch (`consolidated_at` and
 * `dispatch_id` of both `pending_*` tables, migration 014). The `pending_*` rows are kept after the
 * dispatch exists, so this mark is what tells a consolidated order from one that still waits.
 */
export abstract class ConsolidationRecord {
    /** The mark of the order, or `null` if it was not consolidated. */
    abstract find(salesOrderId: string, options?: TransactionOptions): Promise<ConsolidationMark | null>;

    /** Marks the rows of both sources of the order as consolidated into `dispatchId`. */
    abstract mark(
        salesOrderId: string,
        mark: ConsolidationMark,
        options?: TransactionOptions,
    ): Promise<void>;
}
