import { BadRequestException } from '@nestjs/common';

export class PasswordInvalidCharactersException extends BadRequestException {
    constructor() {
        super({ message: 'Password contains characters that are not allowed.', error: 'PASSWORD_INVALID_CHARACTERS' });
    }
}
