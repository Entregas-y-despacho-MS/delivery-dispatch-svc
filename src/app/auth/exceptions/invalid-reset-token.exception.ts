import { UnauthorizedException } from '@nestjs/common';

export class InvalidResetTokenException extends UnauthorizedException {
    constructor() {
        super({ message: 'Invalid or expired password reset token.', error: 'INVALID_RESET_TOKEN' });
    }
}
