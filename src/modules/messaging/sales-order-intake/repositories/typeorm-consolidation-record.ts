import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { ConsolidationRecord, type ConsolidationMark } from '../ports/consolidation-record.port.js';

/**
 * `ConsolidationRecord` on top of `consolidated_at` and `dispatch_id` of `pending_sales_orders` and
 * `pending_shipments` (migration 014). It uses plain SQL on purpose: the entities of those tables
 * must not map the two columns before the migration exists, or every `find` would select them.
 */
@Injectable()
export class TypeOrmConsolidationRecord extends ConsolidationRecord {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async find(salesOrderId: string, options?: TransactionOptions): Promise<ConsolidationMark | null> {
        const manager = options?.manager ?? this.dataSource.manager;
        const rows: { dispatch_id: number; consolidated_at: Date }[] = await manager.query(
            `SELECT dispatch_id, consolidated_at
               FROM pending_sales_orders
              WHERE sales_order_id = $1 AND consolidated_at IS NOT NULL`,
            [salesOrderId],
        );
        if (rows.length === 0) return null;
        return { dispatchId: rows[0].dispatch_id, consolidatedAt: new Date(rows[0].consolidated_at) };
    }

    /** Both updates run in the transaction of the caller, so they commit with the dispatch. */
    async mark(salesOrderId: string, mark: ConsolidationMark, options?: TransactionOptions): Promise<void> {
        const manager = options?.manager ?? this.dataSource.manager;
        const params = [salesOrderId, mark.consolidatedAt, mark.dispatchId];
        await manager.query(
            `UPDATE pending_sales_orders SET consolidated_at = $2, dispatch_id = $3 WHERE sales_order_id = $1`,
            params,
        );
        await manager.query(
            `UPDATE pending_shipments SET consolidated_at = $2, dispatch_id = $3 WHERE sales_order_id = $1`,
            params,
        );
    }
}
