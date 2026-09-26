import { ForbiddenException } from '@nestjs/common';

export class CannotModifyOwnAccountException extends ForbiddenException {
    constructor() {
        super({
            message: 'You cannot delete, deactivate or change the role of your own account. Ask another administrator.',
            error:   'CANNOT_MODIFY_OWN_ACCOUNT',
        });
    }
}
