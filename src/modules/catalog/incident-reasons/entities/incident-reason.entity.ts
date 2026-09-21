import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('incident_reasons')
export class IncidentReason extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'incident_reason_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 150 })
    name: string;
}
