import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';

// Append-only log — a recorded event is never modified, no updatedAt.
@Entity('dispatch_events')
export class DispatchEvent extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'dispatch_event_id' })
    id: number;

    @Column({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    // created | assigned | status_changed | ...
    @Column({ name: 'event_type', type: 'varchar', length: 50 })
    eventType: string;

    @Column({ name: 'detail', type: 'text', nullable: true })
    detail: string | null;

    @ManyToOne(() => Dispatch)
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;
}
