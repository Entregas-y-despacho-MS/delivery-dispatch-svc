import { describe, expect, it, vi } from 'vitest';
import { PushToken } from '../entities/push-token.entity.js';
import { PushPlatformEnum } from '../enums/push-platform.enum.js';
import { PushTokensRepository } from './push-tokens.repository.js';

const INPUT = { userId: 7, deviceId: 'device-1', token: 'ExponentPushToken[abc]', platform: PushPlatformEnum.ANDROID };
const ROW = {
    push_token_id: 1, user_id: 7, device_id: 'device-1', token: 'ExponentPushToken[abc]', platform: 'android',
    last_used_at: new Date('2026-10-18T12:00:00Z'), revoked_at: null,
    created_at: new Date('2026-10-18T12:00:00Z'), updated_at: new Date('2026-10-18T12:00:00Z'),
};

describe('PushTokensRepository', () => {
    const buildManager = () => {
        const update = { set: vi.fn(), where: vi.fn(), execute: vi.fn().mockResolvedValue({ affected: 1 }) };
        update.set.mockReturnValue(update);
        update.where.mockReturnValue(update);
        const repo = {
            find:   vi.fn().mockResolvedValue([]),
            create: vi.fn((v) => Object.assign(new PushToken(), v)),
        };
        const manager = {
            query:              vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]),
            createQueryBuilder: vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue(update) }),
            getRepository:      vi.fn().mockReturnValue(repo),
        };
        return { manager, update, repo };
    };
    const build = () => {
        const parts = buildManager();
        const dataSource = {
            manager:     parts.manager,
            transaction: vi.fn((work: (m: unknown) => Promise<unknown>) => work(parts.manager)),
        };
        return { ...parts, dataSource, repository: new PushTokensRepository(dataSource as never) };
    };

    describe('register', () => {
        it('runs inside its own transaction when no manager is given', async () => {
            const { repository, dataSource } = build();

            await repository.register(INPUT);

            expect(dataSource.transaction).toHaveBeenCalledOnce();
        });

        it('joins the transaction of the caller and does not open another', async () => {
            const { repository, dataSource, manager } = build();
            const own = buildManager();

            await repository.register(INPUT, { manager: own.manager as never });

            expect(dataSource.transaction).not.toHaveBeenCalled();
            expect(own.manager.query).toHaveBeenCalledTimes(2);
            expect(manager.query).not.toHaveBeenCalled();
        });

        it('first revokes the active rows that hold the same token under another owner', async () => {
            const { repository, manager } = build();

            await repository.register(INPUT);

            const [sql, params] = manager.query.mock.calls[0];
            expect(sql).toContain('UPDATE push_tokens');
            expect(sql).toContain('revoked_at IS NULL');
            expect(sql).toContain('NOT (user_id = $2 AND device_id = $3)');
            expect(params).toEqual([INPUT.token, INPUT.userId, INPUT.deviceId]);
        });

        it('then writes with one upsert on (user_id, device_id) that reactivates a revoked row', async () => {
            const { repository, manager } = build();

            await repository.register(INPUT);

            const [sql, params] = manager.query.mock.calls[1];
            expect(sql).toContain('INSERT INTO push_tokens');
            expect(sql).toContain('ON CONFLICT (user_id, device_id) DO UPDATE');
            expect(sql).toContain('revoked_at   = NULL');
            expect(sql).toContain('last_used_at = NOW()');
            expect(params).toEqual([INPUT.userId, INPUT.deviceId, INPUT.token, INPUT.platform]);
        });

        it('returns the stored row mapped to the entity', async () => {
            const { repository } = build();

            const saved = await repository.register(INPUT);

            expect(saved).toMatchObject({ id: 1, userId: 7, deviceId: 'device-1', token: INPUT.token, platform: 'android', revokedAt: null });
        });
    });

    describe('revokeByDevice', () => {
        it('revokes only the active token of that user and device and returns how many rows changed', async () => {
            const { repository, update, manager } = build();

            const revoked = await repository.revokeByDevice(7, 'device-1');

            expect(manager.createQueryBuilder().update).toHaveBeenCalledWith(PushToken);
            const where = update.where.mock.calls[0][0];
            expect(where).toMatchObject({ userId: 7, deviceId: 'device-1' });
            expect(where.revokedAt).toBeDefined(); // IsNull(): an already revoked row is not touched again
            expect(revoked).toBe(1);
        });

        it('answers 0 when there was nothing to revoke', async () => {
            const { repository, update } = build();
            update.execute.mockResolvedValue({ affected: undefined });

            await expect(repository.revokeByDevice(7, 'unknown')).resolves.toBe(0);
        });
    });

    describe('revokeByToken', () => {
        it('revokes the active rows with that token whoever owns them', async () => {
            const { repository, update } = build();

            await expect(repository.revokeByToken('ExponentPushToken[abc]')).resolves.toBe(1);

            const where = update.where.mock.calls[0][0];
            expect(where).toMatchObject({ token: 'ExponentPushToken[abc]' });
            expect(where).not.toHaveProperty('userId');
            expect(where.revokedAt).toBeDefined();
        });
    });

    describe('findActiveByUserId', () => {
        it('lists only the non-revoked tokens of the user, most recently used first', async () => {
            const { repository, repo } = build();

            await repository.findActiveByUserId(7);

            const options = repo.find.mock.calls[0][0];
            expect(options.where).toMatchObject({ userId: 7 });
            expect(options.where.revokedAt).toBeDefined();
            expect(options.order).toEqual({ lastUsedAt: 'DESC', id: 'DESC' });
        });
    });
});
