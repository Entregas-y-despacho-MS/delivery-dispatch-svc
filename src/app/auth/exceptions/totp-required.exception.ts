import { UnauthorizedException } from '@nestjs/common';

export class TotpRequiredException extends UnauthorizedException {
    constructor() {
        super({ message: 'A TOTP code is required to complete login.', error: 'TOTP_REQUIRED' });
    }
}
