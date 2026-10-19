import { ConflictException } from '@nestjs/common';

export class DispatchTypeNotSupportedException extends ConflictException {
    constructor(type: string) {
        super({
            message: `Only delivery dispatches can be rescheduled or returned from here (type: ${type}). Pickups are rescheduled from their own flow.`,
            error:   'DISPATCH_TYPE_NOT_SUPPORTED',
        });
    }
}
