import { BadRequestException } from '@nestjs/common';

export class PasswordTooWeakException extends BadRequestException {
    constructor(missing: string[]) {
        super({ message: `Password must include at least ${missing.join(', ')}.`, error: 'PASSWORD_TOO_WEAK' });
    }
}
