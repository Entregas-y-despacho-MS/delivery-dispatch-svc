import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BaseEntitySoftDelete } from '../../../database/entities/base.entity.js';
import { Role } from '../../roles/entities/role.entity.js';

@Entity('users')
export class User extends BaseEntitySoftDelete {
    @PrimaryGeneratedColumn({ name: 'user_id' })
    id: number;

    @Column({ name: 'role_id', type: 'int' })
    roleId: number;

    @Column({ name: 'full_name', type: 'varchar', length: 150 })
    fullName: string;

    @Column({ name: 'username', type: 'varchar', length: 50 })
    username: string;

    @Column({ name: 'email', type: 'varchar', length: 150, nullable: true })
    email: string | null;

    @Column({ name: 'password_hash', type: 'varchar', length: 255 })
    passwordHash: string;

    @Column({ name: 'password_changed_at', type: 'timestamptz' })
    passwordChangedAt: Date;

    @Column({ name: 'failed_attempts', type: 'smallint', default: 0 })
    failedAttempts: number;

    @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
    lockedUntil: Date | null;

    @Column({ name: 'refresh_token_hash', type: 'varchar', length: 255, nullable: true })
    refreshTokenHash: string | null;

    @Column({ name: 'requires_pwd_change', type: 'boolean', default: true })
    requiresPwdChange: boolean;

    @Column({ name: 'password_reset_token', type: 'varchar', length: 255, nullable: true })
    passwordResetToken: string | null;

    @Column({ name: 'password_reset_expires_at', type: 'timestamptz', nullable: true })
    passwordResetExpiresAt: Date | null;

    @Column({ name: 'two_factor_secret', type: 'varchar', length: 255, nullable: true })
    twoFactorSecret: string | null;

    @Column({ name: 'two_factor_enabled', type: 'boolean', default: false })
    twoFactorEnabled: boolean;

    @Column({ name: 'active', type: 'boolean', default: true })
    active: boolean;

    @ManyToOne(() => Role, (role) => role.users)
    @JoinColumn({ name: 'role_id' })
    role: Role;
}
