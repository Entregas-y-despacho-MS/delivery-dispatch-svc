import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';
import { VehicleStatus } from '../../vehicle-statuses/entities/vehicle-status.entity.js';

@Entity('vehicles')
export class Vehicle extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'vehicle_id' })
    id: number;

    @Column({ name: 'vehicle_status_id', type: 'int' })
    vehicleStatusId: number;

    @Column({ name: 'type', type: 'varchar', length: 50 })
    type: string;

    @Column({ name: 'plate', type: 'varchar', length: 15 })
    plate: string;

    @Column({ name: 'capacity_kg', type: 'numeric', precision: 10, scale: 2 })
    capacityKg: string;

    @ManyToOne(() => VehicleStatus)
    @JoinColumn({ name: 'vehicle_status_id' })
    vehicleStatus: VehicleStatus;
}
