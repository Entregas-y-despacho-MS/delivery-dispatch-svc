import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Append-only — a row is never updated, only inserted (the password it just replaced) and read
// (last 3 per user) when checking reuse. No soft delete, no updatedAt.
@Entity('password_history')
export class PasswordHistory {
    @PrimaryGeneratedColumn({ name: 'password_history_id' })
    id: number;

    @Column({ name: 'user_id', type: 'int' })
    userId: number;

    @Column({ name: 'password_hash', type: 'varchar', length: 255 })
    passwordHash: string;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
