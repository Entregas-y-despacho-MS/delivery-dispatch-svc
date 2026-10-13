import { Injectable } from '@nestjs/common';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { ShipmentBlocks } from '../../sales-order-intake/domain/consolidated-order.types.js';
import { ShipmentBlocksReader } from '../../sales-order-intake/ports/shipment-blocks.reader.js';
import { PendingShipmentStore } from '../ports/pending-shipment.store.js';

/** Reads the retained, merged Almacén blocks through the same transaction as consolidation. */
@Injectable()
export class TypeOrmShipmentBlocksReader extends ShipmentBlocksReader {
    constructor(private readonly pending: PendingShipmentStore) {
        super();
    }

    async find(salesOrderId: string, options?: TransactionOptions): Promise<ShipmentBlocks | null> {
        const record = await this.pending.find(salesOrderId, options);
        return record ? structuredClone(record.blocks) : null;
    }
}
