import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { PendingShipment } from '../entities/pending-shipment.entity.js';
import { PendingShipmentStore, type PendingShipmentRecord } from '../ports/pending-shipment.store.js';

/** Writes the merged blocks without deleting the retained consolidation link. */
@Injectable()
export class TypeOrmPendingShipmentStore extends PendingShipmentStore {
    constructor(
        @InjectRepository(PendingShipment) private readonly rawRepo: Repository<PendingShipment>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async find(salesOrderId: string, options?: MutationOptions): Promise<PendingShipmentRecord | null> {
        const repo = options?.manager?.getRepository(PendingShipment) ?? this.rawRepo;
        const row = await repo.findOneBy({ salesOrderId });
        return row ? {
            salesOrderId: row.salesOrderId,
            recordVersion: Number(row.recordVersion),
            blocks: structuredClone(row.payload),
        } : null;
    }

    async save(record: PendingShipmentRecord, options?: MutationOptions): Promise<void> {
        const sql = `INSERT INTO pending_shipments (sales_order_id, record_version, payload)
                     VALUES ($1, $2, $3::jsonb)
                     ON CONFLICT (sales_order_id) DO UPDATE SET
                         record_version = EXCLUDED.record_version,
                         payload = EXCLUDED.payload,
                         updated_at = NOW()
                     WHERE pending_shipments.record_version <= EXCLUDED.record_version`;
        const values = [record.salesOrderId, String(record.recordVersion), JSON.stringify(record.blocks)];
        if (options?.manager) await options.manager.query(sql, values);
        else await this.dataSource.query(sql, values);
    }
}
