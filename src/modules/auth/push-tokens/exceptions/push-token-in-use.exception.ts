import { ConflictException } from '@nestjs/common';

export class PushTokenInUseException extends ConflictException {
    constructor() {
        super({ message: 'This push token was just registered by another user. Try again.', error: 'PUSH_TOKEN_IN_USE' });
    }
}
