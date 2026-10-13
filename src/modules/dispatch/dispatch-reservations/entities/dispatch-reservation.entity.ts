import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Dispatch } from '../../dispatches/entities/dispatch.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';

@Entity('dispatch_reservations')
export class DispatchReservation {
    @PrimaryColumn({ name: 'dispatch_id', type: 'int' })
    dispatchId: number;

    @Column({ name: 'reserved_by', type: 'int' })
    reservedBy: number;

    @Column({ name: 'reserved_at', type: 'timestamptz' })
    reservedAt: Date;

    @Column({ name: 'last_activity_at', type: 'timestamptz' })
    lastActivityAt: Date;

    @Column({ name: 'expires_at', type: 'timestamptz' })
    expiresAt: Date;

    @ManyToOne(() => Dispatch, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'dispatch_id' })
    dispatch: Dispatch;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'reserved_by' })
    reservedByUser: User;
}
