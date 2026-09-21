import { BadRequestException } from '@nestjs/common';

export class PasswordRecentlyUsedException extends BadRequestException {
    constructor() {
        super({ message: 'You cannot reuse your current password or any of your last 3 passwords.', error: 'PASSWORD_RECENTLY_USED' });
    }
}
