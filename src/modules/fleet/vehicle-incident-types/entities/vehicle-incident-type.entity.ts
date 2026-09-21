import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('vehicle_incident_types')
export class VehicleIncidentType extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'vehicle_incident_type_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 100 })
    name: string;
}
