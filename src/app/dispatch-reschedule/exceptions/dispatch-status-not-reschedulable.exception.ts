import { ConflictException } from '@nestjs/common';

export class DispatchStatusNotReschedulableException extends ConflictException {
    constructor(status: string) {
        super({
            message: `A dispatch can only be rescheduled while it is in incident, not_delivered, scheduled or assigned (current status: ${status}).`,
            error:   'DISPATCH_STATUS_NOT_RESCHEDULABLE',
        });
    }
}
