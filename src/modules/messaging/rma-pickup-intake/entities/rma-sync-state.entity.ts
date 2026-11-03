import { Column, Entity, PrimaryColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

/** Migration 021: high-water mark of the RMA pickup orders consumed from `inventory.return.requested`. */
@Entity('rma_sync_states')
export class RmaSyncState extends BaseCreatedUpdated {
    @PrimaryColumn({ name: 'rma_id', type: 'varchar', length: 100 })
    rmaId: string;

    // PostgreSQL BIGINT is represented as a string to avoid precision loss.
    @Column({ name: 'last_record_version', type: 'bigint', default: 0 })
    lastRecordVersion: string;
}
