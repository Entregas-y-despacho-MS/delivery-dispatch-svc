import { ForbiddenException } from '@nestjs/common';

export class PasswordChangeRequiredException extends ForbiddenException {
    constructor() {
        super({
            message: 'You must change your password before using the system (PATCH /auth/change-password).',
            error:   'PASSWORD_CHANGE_REQUIRED',
        });
    }
}
