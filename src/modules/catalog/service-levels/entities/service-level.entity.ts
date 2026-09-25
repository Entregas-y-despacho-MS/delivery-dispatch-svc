import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('service_levels')
export class ServiceLevel extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'service_level_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 50 })
    name: string;

    @Column({ name: 'description', type: 'varchar', length: 255, nullable: true })
    description: string | null;

    @Column({ name: 'target_time_min', type: 'int' })
    targetTimeMin: number;

    // Priority hierarchy: 1 = highest. Levels may share a value (ties are broken by target time).
    @Column({ name: 'priority_level', type: 'smallint' })
    priorityLevel: number;

    // Disabled levels can't be assigned to new orders; dispatches that already have one keep it.
    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;
}
