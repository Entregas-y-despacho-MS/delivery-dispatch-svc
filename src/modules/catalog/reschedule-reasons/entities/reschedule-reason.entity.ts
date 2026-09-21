import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('reschedule_reasons')
export class RescheduleReason extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'reschedule_reason_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 150 })
    name: string;
}
