import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import type { ShipmentBlocks } from '../domain/shipment-message.types.js';

/** Canonical Inventory blocks from migration 014, retained after consolidation. */
@Entity('pending_shipments')
export class PendingShipment extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'sales_order_id', type: 'varchar', length: 100 })
    salesOrderId: string;

    @Column({ name: 'record_version', type: 'bigint' })
    recordVersion: string;

    @Column({ name: 'payload', type: 'jsonb' })
    payload: ShipmentBlocks;

    @Column({ name: 'consolidated_at', type: 'timestamptz', nullable: true })
    consolidatedAt: Date | null;

    @Column({ name: 'dispatch_id', type: 'int', nullable: true })
    dispatchId: number | null;
}
