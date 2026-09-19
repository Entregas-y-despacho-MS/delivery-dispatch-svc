import { UnauthorizedException } from '@nestjs/common';

export class InvalidCredentialsException extends UnauthorizedException {
    constructor() {
        super({ message: 'Invalid credentials.', error: 'INVALID_CREDENTIALS' });
    }
}
