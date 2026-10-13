import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';
import { RouteBatch } from './route-batch.entity.js';

// Append-only history; the database rejects UPDATE and restricts DELETE.
@Entity('route_batch_events')
export class RouteBatchEvent extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'route_batch_event_id' })
    id: number;

    @Column({ name: 'route_batch_id', type: 'int' })
    routeBatchId: number;

    @Column({ name: 'dispatch_id', type: 'int', nullable: true })
    dispatchId: number | null;

    @Column({ name: 'event_type', type: 'varchar', length: 50 })
    eventType: string;

    @Column({ name: 'actor_user_id', type: 'int', nullable: true })
    actorUserId: number | null;

    @Column({ name: 'actor_type', type: 'varchar', length: 20 })
    actorType: 'user' | 'system' | 'customer';

    @Column({ name: 'reason', type: 'text', nullable: true })
    reason: string | null;

    @Column({ name: 'metadata', type: 'jsonb', nullable: true })
    metadata: Record<string, unknown> | null;

    @ManyToOne(() => RouteBatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'route_batch_id' })
    routeBatch: RouteBatch;

    @ManyToOne(() => Dispatch, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch | null;

    @ManyToOne(() => User, { onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'actor_user_id' })
    actorUser: User | null;
}
