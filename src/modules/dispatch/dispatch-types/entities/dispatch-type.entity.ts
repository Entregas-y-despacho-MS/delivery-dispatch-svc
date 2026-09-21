import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';

// Catalog — delivery | warehouse_return_pickup | supplier_pickup | supplier_return. No soft delete.
@Entity('dispatch_types')
export class DispatchType extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_type_id' })
    id: number;

    @Column({ name: 'name', type: 'varchar', length: 50, unique: true })
    name: string;
}
