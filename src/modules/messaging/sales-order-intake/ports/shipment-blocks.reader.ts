import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { ShipmentBlocks } from '../domain/consolidated-order.types.js';

/**
 * Read-only port over the Almacén blocks of a sales order. The adapter (ST-72.1) reads the merged
 * payload of `pending_shipments`; `tryConsolidate` only needs to read it, never to write it.
 */
export abstract class ShipmentBlocksReader {
    /** The merged blocks of Almacén, or `null` if nothing from Almacén was stored. */
    abstract find(salesOrderId: string, options?: TransactionOptions): Promise<ShipmentBlocks | null>;
}
