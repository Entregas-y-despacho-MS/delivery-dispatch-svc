import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

// Catalog — active | maintenance | out_of_service. No soft delete.
@Entity('vehicle_statuses')
export class VehicleStatus extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'vehicle_status_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 30, unique: true })
    name: string;
}
