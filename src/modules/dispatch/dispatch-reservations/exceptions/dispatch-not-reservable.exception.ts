import { ConflictException } from '@nestjs/common';

export class DispatchNotReservableException extends ConflictException {
    constructor(dispatchIds: number[]) {
        super({
            message: `These orders are not available for planning (missing, or neither pending nor rescheduled for today): ${dispatchIds.join(', ')}.`,
            error:   'DISPATCH_NOT_RESERVABLE',
        });
    }
}
