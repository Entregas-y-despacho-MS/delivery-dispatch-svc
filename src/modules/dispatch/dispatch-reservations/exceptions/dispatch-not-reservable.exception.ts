import { ConflictException } from '@nestjs/common';

export class DispatchNotReservableException extends ConflictException {
    constructor(dispatchIds: number[]) {
        super({
            message: `These orders are not available for planning (missing, in address review, or not pending, in planning or rescheduled for today): ${dispatchIds.join(', ')}.`,
            error:   'DISPATCH_NOT_RESERVABLE',
        });
    }
}
