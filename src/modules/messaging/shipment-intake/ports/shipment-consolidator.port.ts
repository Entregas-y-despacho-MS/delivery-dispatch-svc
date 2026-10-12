import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';

/** Bound to ST-72.2's OrderConsolidator when both consumer modules are integrated. */
export abstract class ShipmentConsolidator {
    abstract tryConsolidate(salesOrderId: string, options: TransactionOptions): Promise<unknown>;
}
