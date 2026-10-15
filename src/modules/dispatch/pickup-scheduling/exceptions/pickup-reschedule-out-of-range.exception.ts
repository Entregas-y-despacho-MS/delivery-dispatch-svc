import { ConflictException } from '@nestjs/common';

export class PickupRescheduleOutOfRangeException extends ConflictException {
    constructor(maxDays: number) {
        super({
            message: `The new pickup cannot start more than ${maxDays} day(s) after the current one, and must be later than it.`,
            error:   'PICKUP_RESCHEDULE_OUT_OF_RANGE',
        });
    }
}
