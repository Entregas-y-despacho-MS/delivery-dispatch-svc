import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import type { MarketplaceOrderBlocks } from '../domain/marketplace-order.types.js';

/** `BIGINT` comes back from `pg` as a string; the versions of the contracts fit in a safe integer. */
const bigintAsNumber = {
    to: (value: number): number => value,
    from: (value: string | null): number | null => (value === null ? null : Number(value)),
};

/**
 * Delivery data received from Marketplace for a sales order (table `pending_sales_orders`,
 * migration 012). One row per order; `payload` holds the blocks merged so far. The row is kept
 * after the order becomes a dispatch: the merged payload is the state of this origin.
 *
 * The version of the origin that rules idempotency lives in `sales_order_sync_states`;
 * `record_version` here is informational and never goes down.
 */
@Entity('pending_sales_orders')
export class PendingSalesOrder extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'sales_order_id', type: 'varchar', length: 100 })
    salesOrderId: string;

    @Column({ name: 'record_version', type: 'bigint', transformer: bigintAsNumber })
    recordVersion: number;

    // Blocks received from Marketplace, merged by block (see `applyMarketplaceMessage`).
    @Column({ name: 'payload', type: 'jsonb' })
    payload: MarketplaceOrderBlocks;
}
