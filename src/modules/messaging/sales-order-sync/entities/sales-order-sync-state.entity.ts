import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

/** Migration 014: high-water mark and cancellation for one sales order and one ERP origin. */
@Entity('sales_order_sync_states')
export class SalesOrderSyncState extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'sales_order_id', type: 'varchar', length: 100 })
    salesOrderId: string;

    @PrimaryColumn({ name: 'source', type: 'varchar', length: 20 })
    source: 'marketplace' | 'inventory';

    // PostgreSQL BIGINT is represented as a string to avoid precision loss.
    @Column({ name: 'last_record_version', type: 'bigint', default: 0 })
    lastRecordVersion: string;

    @Column({ name: 'base_received', type: 'boolean', default: false })
    baseReceived: boolean;

    @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
    cancelledAt: Date | null;

    @Column({ name: 'cancelled_record_version', type: 'bigint', nullable: true })
    cancelledVersion: string | null;

    @Column({ name: 'sync_attempts', type: 'smallint', default: 0 })
    syncAttempts: number;

    @Column({ name: 'last_sync_requested_at', type: 'timestamptz', nullable: true })
    lastSyncRequestedAt: Date | null;

    @Column({ name: 'incomplete_alerted_at', type: 'timestamptz', nullable: true })
    incompleteAlertedAt: Date | null;
}
