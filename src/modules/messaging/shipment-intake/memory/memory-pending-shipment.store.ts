import { Injectable } from '@nestjs/common';
import { PendingShipmentStore, type PendingShipmentRecord } from '../ports/pending-shipment.store.js';

@Injectable()
export class MemoryPendingShipmentStore extends PendingShipmentStore {
    private rows = new Map<string, PendingShipmentRecord>();

    async find(salesOrderId: string): Promise<PendingShipmentRecord | null> {
        const row = this.rows.get(salesOrderId);
        return row ? structuredClone(row) : null;
    }

    async save(record: PendingShipmentRecord): Promise<void> {
        const previous = this.rows.get(record.salesOrderId);
        if (previous && previous.recordVersion > record.recordVersion) return;
        this.rows.set(record.salesOrderId, structuredClone(record));
    }

    snapshot(): Map<string, PendingShipmentRecord> {
        return structuredClone(this.rows);
    }

    restore(snapshot: Map<string, PendingShipmentRecord>): void {
        this.rows = structuredClone(snapshot);
    }
}
