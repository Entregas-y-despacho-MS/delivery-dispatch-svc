import { BadRequestException } from '@nestjs/common';

export class PasswordTooShortException extends BadRequestException {
    constructor(minLength: number) {
        super({ message: `Password must be at least ${minLength} characters.`, error: 'PASSWORD_TOO_SHORT' });
    }
}
