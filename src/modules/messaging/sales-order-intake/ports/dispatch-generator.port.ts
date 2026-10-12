import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { ConsolidatedOrder } from '../domain/consolidated-order.types.js';

export interface CreatedDispatch {
    dispatchId: number;
}

/**
 * Port to the service that creates the dispatch of a consolidated order (`ST-49.1`).
 *
 * Contract for the adapter:
 * - It runs inside the transaction of `options.manager`: the dispatch, its packages and the
 *   consolidation mark commit together with the receipt of the message.
 * - It creates one dispatch of type `delivery` per sales order. The partial unique index
 *   `uq_dispatches_delivery_source_order_ref` is the safety net; `tryConsolidate` already skips an
 *   order that was consolidated, so a repeated call is a bug, not a normal case.
 * - Without `deliveryAddress.location` it creates the dispatch in `address_review`.
 */
export abstract class DispatchGenerator {
    abstract createFromConsolidated(order: ConsolidatedOrder, options: TransactionOptions): Promise<CreatedDispatch>;
}
