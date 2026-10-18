import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../../../shared/orm/unique-violation.js';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { PushToken } from '../entities/push-token.entity.js';
import { PushTokenInUseException } from '../exceptions/index.js';
import { PushTokensRepository } from '../repositories/push-tokens.repository.js';
import type { RegisterPushTokenDto } from '../dto/register-push-token.dto.js';

@Injectable()
export class PushTokensService {
    constructor(private readonly repository: PushTokensRepository) {}

    /** Registers or refreshes the token of one device of the user. Idempotent. */
    async register(userId: number, deviceId: string, dto: RegisterPushTokenDto, options?: MutationOptions): Promise<PushToken> {
        try {
            return await this.repository.register({ userId, deviceId, token: dto.token, platform: dto.platform }, options);
        } catch (err) {
            // Two users registering the same token at the very same moment: the loser hits the partial unique index.
            if (isUniqueViolation(err)) throw new PushTokenInUseException();
            throw err;
        }
    }

    /** Logout of one device. Revoking something already revoked, or never registered, is not an error. */
    async revoke(userId: number, deviceId: string, options?: MutationOptions): Promise<void> {
        await this.repository.revokeByDevice(userId, deviceId, options);
    }

    /** Active tokens of a user — what the push sender (ST-36.2) addresses. */
    async findActiveByUserId(userId: number, options?: MutationOptions): Promise<PushToken[]> {
        return await this.repository.findActiveByUserId(userId, options);
    }

    /** The provider rejected the token (`DeviceNotRegistered`) — what the push sender (ST-36.2) calls. */
    async revokeByToken(token: string, options?: MutationOptions): Promise<number> {
        return await this.repository.revokeByToken(token, options);
    }
}
