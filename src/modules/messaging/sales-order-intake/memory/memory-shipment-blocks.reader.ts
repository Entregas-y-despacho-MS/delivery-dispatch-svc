import { Injectable } from '@nestjs/common';
import type { ShipmentBlocks } from '../domain/consolidated-order.types.js';
import { ShipmentBlocksReader } from '../ports/shipment-blocks.reader.js';

/** In-memory `ShipmentBlocksReader` for tests; `set` stands for what the Almacén consumer stored. */
@Injectable()
export class MemoryShipmentBlocksReader extends ShipmentBlocksReader {
    private readonly rows = new Map<string, ShipmentBlocks>();

    set(salesOrderId: string, blocks: ShipmentBlocks): void {
        this.rows.set(salesOrderId, structuredClone(blocks));
    }

    async find(salesOrderId: string): Promise<ShipmentBlocks | null> {
        const row = this.rows.get(salesOrderId);
        return row ? structuredClone(row) : null;
    }
}
