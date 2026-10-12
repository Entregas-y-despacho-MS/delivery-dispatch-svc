import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { PendingSalesOrder } from '../entities/pending-sales-order.entity.js';
import { PendingSalesOrderStore, type PendingSalesOrderRecord } from '../ports/pending-sales-order.store.js';

/** `PendingSalesOrderStore` on top of the table `pending_sales_orders`. */
@Injectable()
export class TypeOrmPendingSalesOrderStore extends PendingSalesOrderStore {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async find(salesOrderId: string, options?: MutationOptions): Promise<PendingSalesOrderRecord | null> {
        const manager = options?.manager ?? this.dataSource.manager;
        const row = await manager.getRepository(PendingSalesOrder).findOneBy({ salesOrderId });
        if (!row) return null;
        return { salesOrderId: row.salesOrderId, recordVersion: row.recordVersion, blocks: row.payload };
    }

    /**
     * One upsert statement. `GREATEST` keeps the stored version from going down when a late base
     * completes blocks of a newer record.
     */
    async save(record: PendingSalesOrderRecord, options?: MutationOptions): Promise<void> {
        const manager = options?.manager ?? this.dataSource.manager;
        await manager.query(
            `INSERT INTO pending_sales_orders (sales_order_id, record_version, payload)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (sales_order_id) DO UPDATE
                SET record_version = GREATEST(pending_sales_orders.record_version, EXCLUDED.record_version),
                    payload        = EXCLUDED.payload,
                    updated_at     = NOW()`,
            [record.salesOrderId, record.recordVersion, JSON.stringify(record.blocks)],
        );
    }
}
