import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { RescheduleReason } from '../../../catalog/reschedule-reasons/entities/reschedule-reason.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';
import { RouteBatch } from '../../route-batches/entities/route-batch.entity.js';

// Append-only log — covers both rescheduling (window change) and reassignment (route change);
// a row is never modified once written, no updatedAt.
@Entity('dispatch_reschedules')
export class DispatchReschedule extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'dispatch_reschedule_id' })
    id: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'reschedule_reason_id', type: 'int' })
    rescheduleReasonId: number;

    // NULL if it happened automatically.
    @Column({ name: 'rescheduled_by', type: 'int', nullable: true })
    rescheduledBy: number | null;

    @Column({ name: 'previous_route_batch_id', type: 'int', nullable: true })
    previousRouteBatchId: number | null;

    @Column({ name: 'new_route_batch_id', type: 'int', nullable: true })
    newRouteBatchId: number | null;

    @Column({ name: 'previous_window_start', type: 'timestamptz', nullable: true })
    previousWindowStart: Date | null;

    @Column({ name: 'previous_window_end', type: 'timestamptz', nullable: true })
    previousWindowEnd: Date | null;

    @Column({ name: 'new_window_start', type: 'timestamptz', nullable: true })
    newWindowStart: Date | null;

    @Column({ name: 'new_window_end', type: 'timestamptz', nullable: true })
    newWindowEnd: Date | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;

    @ManyToOne(() => RescheduleReason)
    @JoinColumn({ name: 'reschedule_reason_id' })
    rescheduleReason: RescheduleReason;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'rescheduled_by' })
    rescheduledByUser: User | null;

    @ManyToOne(() => RouteBatch)
    @JoinColumn({ name: 'previous_route_batch_id' })
    previousRouteBatch: RouteBatch | null;

    @ManyToOne(() => RouteBatch)
    @JoinColumn({ name: 'new_route_batch_id' })
    newRouteBatch: RouteBatch | null;
}
