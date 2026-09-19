import { ForbiddenException } from '@nestjs/common';

export class InsufficientPermissionsException extends ForbiddenException {
    constructor() {
        super({ message: 'You do not have permission to perform this action.', error: 'INSUFFICIENT_PERMISSIONS' });
    }
}
