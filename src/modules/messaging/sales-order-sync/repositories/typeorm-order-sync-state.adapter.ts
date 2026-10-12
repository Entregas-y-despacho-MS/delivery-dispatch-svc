import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { SalesOrderSyncState } from '../entities/sales-order-sync-state.entity.js';
import {
    OrderSyncStatePort,
    type OrderSyncSource,
    type OrderSyncState,
} from '../ports/order-sync-state.port.js';

/** Migration 014 adapter shared by Marketplace and Inventory. */
@Injectable()
export class TypeOrmOrderSyncStateAdapter extends OrderSyncStatePort {
    constructor(
        @InjectRepository(SalesOrderSyncState) private readonly rawRepo: Repository<SalesOrderSyncState>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async find(
        salesOrderId: string,
        source: OrderSyncSource,
        options?: MutationOptions,
    ): Promise<OrderSyncState | null> {
        const repo = options?.manager?.getRepository(SalesOrderSyncState) ?? this.rawRepo;
        const row = await repo.findOneBy({ salesOrderId, source });
        return row ? this.toState(row) : null;
    }

    async findAllOf(salesOrderId: string, options?: MutationOptions): Promise<OrderSyncState[]> {
        const repo = options?.manager?.getRepository(SalesOrderSyncState) ?? this.rawRepo;
        const rows = await repo.findBy({ salesOrderId });
        return rows.map((row) => this.toState(row));
    }

    async save(state: OrderSyncState, options?: MutationOptions): Promise<void> {
        // Only the origin state is updated. Recovery counters belong to ST-50.5 and must survive.
        const sql = `INSERT INTO sales_order_sync_states
                         (sales_order_id, source, last_record_version, base_received,
                          cancelled_at, cancelled_record_version)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (sales_order_id, source) DO UPDATE SET
                         last_record_version = EXCLUDED.last_record_version,
                         base_received = EXCLUDED.base_received,
                         cancelled_at = EXCLUDED.cancelled_at,
                         cancelled_record_version = EXCLUDED.cancelled_record_version,
                         updated_at = NOW()
                     WHERE sales_order_sync_states.last_record_version <= EXCLUDED.last_record_version`;
        const values = [
            state.salesOrderId,
            state.source,
            String(state.lastRecordVersion),
            state.baseReceived,
            state.cancelledAt,
            state.cancelledVersion === null ? null : String(state.cancelledVersion),
        ];
        if (options?.manager) await options.manager.query(sql, values);
        else await this.dataSource.query(sql, values);
    }

    private toState(row: SalesOrderSyncState): OrderSyncState {
        return {
            salesOrderId: row.salesOrderId,
            source: row.source,
            lastRecordVersion: Number(row.lastRecordVersion),
            baseReceived: row.baseReceived,
            cancelledAt: row.cancelledAt?.toISOString() ?? null,
            cancelledVersion: row.cancelledVersion === null ? null : Number(row.cancelledVersion),
        };
    }
}
