import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BaseCreatedUpdated } from '../../../../database/entities/base.entity.js';
import { PushPlatformEnum } from '../enums/push-platform.enum.js';

/**
 * Migration 019: push token of one device of one user. A row is never deleted by the app — a logout
 * or a rejected token only sets `revokedAt`, so `revokedAt IS NULL` means "active".
 */
@Entity('push_tokens')
export class PushToken extends BaseCreatedUpdated {
    @PrimaryGeneratedColumn({ name: 'push_token_id' })
    id: number;

    @Column({ name: 'user_id', type: 'int' })
    userId: number;

    @Column({ name: 'device_id', type: 'varchar', length: 100 })
    deviceId: string;

    @Column({ name: 'token', type: 'varchar', length: 255 })
    token: string;

    @Column({ name: 'platform', type: 'varchar', length: 10 })
    platform: PushPlatformEnum;

    @Column({ name: 'last_used_at', type: 'timestamptz' })
    lastUsedAt: Date;

    @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
    revokedAt: Date | null;
}
