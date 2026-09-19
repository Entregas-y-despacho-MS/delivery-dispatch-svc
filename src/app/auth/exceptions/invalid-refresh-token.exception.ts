import { UnauthorizedException } from '@nestjs/common';

export class InvalidRefreshTokenException extends UnauthorizedException {
    constructor() {
        super({ message: 'Invalid or expired refresh token.', error: 'INVALID_REFRESH_TOKEN' });
    }
}
