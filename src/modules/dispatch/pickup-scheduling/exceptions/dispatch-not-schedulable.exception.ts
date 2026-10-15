import { ConflictException } from '@nestjs/common';

export class DispatchNotSchedulableException extends ConflictException {
    constructor(reason: string) {
        super({
            message: reason,
            error:   'DISPATCH_NOT_SCHEDULABLE',
        });
    }
}
