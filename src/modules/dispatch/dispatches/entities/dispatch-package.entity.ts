import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { numericTransformer } from '../../../../shared/orm/index.js';
import { Dispatch } from './dispatch.entity.js';

@Entity('dispatch_packages')
@Unique('uq_dispatch_packages_external', ['dispatchId', 'externalPackageId'])
export class DispatchPackage extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_package_id' })
    id: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'external_package_id', type: 'varchar', length: 100 })
    externalPackageId: string;

    @Column({ name: 'length_cm', type: 'numeric', precision: 8, scale: 2, transformer: numericTransformer })
    lengthCm: number;

    @Column({ name: 'width_cm', type: 'numeric', precision: 8, scale: 2, transformer: numericTransformer })
    widthCm: number;

    @Column({ name: 'height_cm', type: 'numeric', precision: 8, scale: 2, transformer: numericTransformer })
    heightCm: number;

    @Column({ name: 'gross_weight_kg', type: 'numeric', precision: 10, scale: 3, transformer: numericTransformer })
    grossWeightKg: number;

    @Column({ name: 'handling_conditions', type: 'text', array: true, default: () => "'{}'" })
    handlingConditions: string[];

    @ManyToOne(() => Dispatch, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;
}
