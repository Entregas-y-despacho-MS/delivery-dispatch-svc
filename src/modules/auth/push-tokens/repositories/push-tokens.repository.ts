import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { PushToken } from '../entities/push-token.entity.js';
import type { PushPlatformEnum } from '../enums/push-platform.enum.js';

export interface RegisterPushTokenInput {
    userId:   number;
    deviceId: string;
    token:    string;
    platform: PushPlatformEnum;
}

/** Persistence of `push_tokens`. Every method accepts `{ manager }` to join a transaction. */
@Injectable()
export class PushTokensRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * Registers the token of a device, or refreshes it, in one atomic operation:
     *  1. revokes the active rows that hold the same token under another owner (a token belongs to a
     *     phone, so a driver who logs in on a shared phone must not inherit the previous driver's
     *     notifications — the partial unique index `uq_push_tokens_active_token` enforces it);
     *  2. one `INSERT … ON CONFLICT (user_id, device_id) DO UPDATE`: registering the same device again
     *     never duplicates the row, and it reactivates a revoked one.
     * Two simultaneous registrations of the same token by different users can still collide on the
     * partial index; the second one fails with a unique violation (23505) and the caller may retry.
     */
    async register(input: RegisterPushTokenInput, options?: MutationOptions): Promise<PushToken> {
        if (options?.manager) return await this.registerIn(options.manager, input);
        return await this.dataSource.transaction((manager) => this.registerIn(manager, input));
    }

    /** Logout of one device: revokes its active token. Returns how many rows were revoked (0 or 1). */
    async revokeByDevice(userId: number, deviceId: string, options?: MutationOptions): Promise<number> {
        const manager = options?.manager ?? this.dataSource.manager;
        const result = await manager
            .createQueryBuilder()
            .update(PushToken)
            .set({ revokedAt: () => 'NOW()' })
            .where({ userId, deviceId, revokedAt: IsNull() })
            .execute();
        return result.affected ?? 0;
    }

    /** The provider rejected the token (`DeviceNotRegistered`): revokes it whoever owns it. */
    async revokeByToken(token: string, options?: MutationOptions): Promise<number> {
        const manager = options?.manager ?? this.dataSource.manager;
        const result = await manager
            .createQueryBuilder()
            .update(PushToken)
            .set({ revokedAt: () => 'NOW()' })
            .where({ token, revokedAt: IsNull() })
            .execute();
        return result.affected ?? 0;
    }

    /** Active tokens of a user, most recently used first. */
    async findActiveByUserId(userId: number, options?: MutationOptions): Promise<PushToken[]> {
        const manager = options?.manager ?? this.dataSource.manager;
        return await manager.getRepository(PushToken).find({
            where: { userId, revokedAt: IsNull() },
            order: { lastUsedAt: 'DESC', id: 'DESC' },
        });
    }

    private async registerIn(manager: EntityManager, input: RegisterPushTokenInput): Promise<PushToken> {
        await manager.query(
            `UPDATE push_tokens
                SET revoked_at = NOW(), updated_at = NOW()
              WHERE token = $1
                AND revoked_at IS NULL
                AND NOT (user_id = $2 AND device_id = $3)`,
            [input.token, input.userId, input.deviceId],
        );
        const rows: Record<string, unknown>[] = await manager.query(
            `INSERT INTO push_tokens (user_id, device_id, token, platform)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, device_id) DO UPDATE
                SET token        = EXCLUDED.token,
                    platform     = EXCLUDED.platform,
                    last_used_at = NOW(),
                    revoked_at   = NULL,
                    updated_at   = NOW()
             RETURNING push_token_id, user_id, device_id, token, platform, last_used_at, revoked_at, created_at, updated_at`,
            [input.userId, input.deviceId, input.token, input.platform],
        );
        return this.toEntity(manager, rows[0]);
    }

    private toEntity(manager: EntityManager, row: Record<string, unknown>): PushToken {
        return manager.getRepository(PushToken).create({
            id:         row.push_token_id as number,
            userId:     row.user_id as number,
            deviceId:   row.device_id as string,
            token:      row.token as string,
            platform:   row.platform as PushPlatformEnum,
            lastUsedAt: row.last_used_at as Date,
            revokedAt:  row.revoked_at as Date | null,
            createdAt:  row.created_at as Date,
            updatedAt:  row.updated_at as Date,
        });
    }
}
