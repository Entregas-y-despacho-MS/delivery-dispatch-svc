import { UnauthorizedException } from '@nestjs/common';

export class InvalidTotpCodeException extends UnauthorizedException {
    constructor() {
        super({ message: 'Invalid TOTP code.', error: 'INVALID_TOTP_CODE' });
    }
}
