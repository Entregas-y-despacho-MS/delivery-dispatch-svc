import { UnauthorizedException } from '@nestjs/common';

export class SessionExpiredException extends UnauthorizedException {
    constructor() {
        super({ message: 'Session closed due to inactivity. Please log in again.', error: 'SESSION_EXPIRED' });
    }
}
