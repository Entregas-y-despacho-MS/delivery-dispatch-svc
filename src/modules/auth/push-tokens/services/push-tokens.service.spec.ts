import { describe, expect, it, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { PushPlatformEnum } from '../enums/push-platform.enum.js';
import { PushTokenInUseException } from '../exceptions/index.js';
import { PushTokensService } from './push-tokens.service.js';

const DTO = { token: 'ExponentPushToken[abc]', platform: PushPlatformEnum.IOS };

const uniqueViolation = () => new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));

describe('PushTokensService', () => {
    const build = () => {
        const repository = {
            register:         vi.fn().mockResolvedValue({ id: 1 }),
            revokeByDevice:   vi.fn().mockResolvedValue(1),
            revokeByToken:    vi.fn().mockResolvedValue(2),
            findActiveByUserId: vi.fn().mockResolvedValue([]),
        };
        return { repository, service: new PushTokensService(repository as never) };
    };

    it('register passes the owner, the device and the dto to the repository', async () => {
        const { service, repository } = build();

        await service.register(7, 'device-1', DTO);

        expect(repository.register).toHaveBeenCalledWith({ userId: 7, deviceId: 'device-1', token: DTO.token, platform: 'ios' }, undefined);
    });

    it('register turns a unique violation (two users, same token, same instant) into 409 PUSH_TOKEN_IN_USE', async () => {
        const { service, repository } = build();
        repository.register.mockRejectedValue(uniqueViolation());

        await expect(service.register(7, 'device-1', DTO)).rejects.toBeInstanceOf(PushTokenInUseException);
    });

    it('register does not hide any other failure', async () => {
        const { service, repository } = build();
        const boom = new Error('connection lost');
        repository.register.mockRejectedValue(boom);

        await expect(service.register(7, 'device-1', DTO)).rejects.toBe(boom);
    });

    it('revoke never fails because of the state of the device: 0 revoked rows is fine', async () => {
        const { service, repository } = build();
        repository.revokeByDevice.mockResolvedValue(0);

        await expect(service.revoke(7, 'never-registered')).resolves.toBeUndefined();
        expect(repository.revokeByDevice).toHaveBeenCalledWith(7, 'never-registered', undefined);
    });

    it('revokeByToken and findActiveByUserId are what the push sender uses', async () => {
        const { service, repository } = build();

        await expect(service.revokeByToken('t')).resolves.toBe(2);
        await service.findActiveByUserId(7);

        expect(repository.revokeByToken).toHaveBeenCalledWith('t', undefined);
        expect(repository.findActiveByUserId).toHaveBeenCalledWith(7, undefined);
    });
});
