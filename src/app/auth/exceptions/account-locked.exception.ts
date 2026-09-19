import { UnauthorizedException } from '@nestjs/common';

export class AccountLockedException extends UnauthorizedException {
    constructor() {
        super({ message: 'Account is temporarily locked due to too many failed login attempts.', error: 'ACCOUNT_LOCKED' });
    }
}
