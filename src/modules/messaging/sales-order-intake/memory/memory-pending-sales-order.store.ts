import { Injectable } from '@nestjs/common';
import { PendingSalesOrderStore, type PendingSalesOrderRecord } from '../ports/pending-sales-order.store.js';

/** In-memory `PendingSalesOrderStore` for the tests of the consumer. */
@Injectable()
export class MemoryPendingSalesOrderStore extends PendingSalesOrderStore {
    private readonly rows = new Map<string, PendingSalesOrderRecord>();

    async find(salesOrderId: string): Promise<PendingSalesOrderRecord | null> {
        const row = this.rows.get(salesOrderId);
        return row ? structuredClone(row) : null;
    }

    async save(record: PendingSalesOrderRecord): Promise<void> {
        const stored = this.rows.get(record.salesOrderId);
        this.rows.set(record.salesOrderId, {
            ...structuredClone(record),
            recordVersion: Math.max(stored?.recordVersion ?? 0, record.recordVersion),
        });
    }
}
