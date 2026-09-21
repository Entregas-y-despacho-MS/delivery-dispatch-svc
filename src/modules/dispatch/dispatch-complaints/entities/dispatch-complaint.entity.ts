import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';

@Entity('dispatch_complaints')
export class DispatchComplaint extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'dispatch_complaint_id' })
    id: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'description', type: 'text' })
    description: string;

    // open | closed
    @Column({ name: 'status', type: 'varchar', length: 20, default: 'open' })
    status: string;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;
}
