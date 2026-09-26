import { ConflictException } from '@nestjs/common';

export class TwoFactorAlreadyEnabledException extends ConflictException {
    constructor() {
        super({
            message: 'Two-factor authentication is already enabled. Disable it first (POST /auth/2fa/disable) to enrol a new device.',
            error:   'TWO_FACTOR_ALREADY_ENABLED',
        });
    }
}
