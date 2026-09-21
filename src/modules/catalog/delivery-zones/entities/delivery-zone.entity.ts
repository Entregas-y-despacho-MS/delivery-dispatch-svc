import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../../database/entities/base.entity.js';

@Entity('delivery_zones')
export class DeliveryZone extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'delivery_zone_id' })
    id: number;

    @Column({ name: 'code', type: 'varchar', length: 20 })
    code: string;

    @Column({ name: 'name', type: 'varchar', length: 100 })
    name: string;

    @Column({ name: 'estimated_time_min', type: 'int' })
    estimatedTimeMin: number;
}
