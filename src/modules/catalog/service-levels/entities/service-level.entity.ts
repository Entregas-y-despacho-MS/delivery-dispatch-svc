import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('service_levels')
export class ServiceLevel extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'service_level_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 50 })
    name: string;

    @Column({ name: 'target_time_min', type: 'int' })
    targetTimeMin: number;
}
