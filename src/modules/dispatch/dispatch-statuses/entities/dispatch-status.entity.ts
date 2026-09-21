import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

// Catalog — pending | in_transit | delivered | not_delivered | returned. No soft delete.
@Entity('dispatch_statuses')
export class DispatchStatus extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_status_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 30, unique: true })
    name: string;
}
