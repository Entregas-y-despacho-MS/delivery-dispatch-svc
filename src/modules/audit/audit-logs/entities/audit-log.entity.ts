import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreated } from '../../../../database/entities/base.entity.js';
import { User } from '../../../auth/users/entities/user.entity.js';

// Append-only log — a written audit record is never modified, no updatedAt.
@Entity('audit_logs')
export class AuditLog extends BaseCreated {
    @PrimaryGeneratedColumn({ name: 'audit_log_id' })
    id: number;

    // NULL if the user was later deleted.
    @Column({ name: 'user_id', type: 'int', nullable: true })
    userId: number | null;

    // login | password_change | user_created | ...
    @Column({ name: 'action', type: 'varchar', length: 100 })
    action: string;

    @Column({ name: 'detail', type: 'text', nullable: true })
    detail: string | null;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'user_id' })
    user: User | null;
}
