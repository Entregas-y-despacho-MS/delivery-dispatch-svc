import { ForbiddenException } from '@nestjs/common';

export class DispatchNotAssignedException extends ForbiddenException {
    constructor() {
        super({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });
    }
}
