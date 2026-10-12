import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import type { ShipmentBlocks } from '../domain/shipment-message.types.js';

export interface PendingShipmentRecord {
    salesOrderId: string;
    recordVersion: number;
    blocks: ShipmentBlocks;
}

/** Canonical Inventory blocks; consolidation metadata remains attached to the stored row. */
export abstract class PendingShipmentStore {
    abstract find(salesOrderId: string, options?: MutationOptions): Promise<PendingShipmentRecord | null>;
    abstract save(record: PendingShipmentRecord, options?: MutationOptions): Promise<void>;
}
