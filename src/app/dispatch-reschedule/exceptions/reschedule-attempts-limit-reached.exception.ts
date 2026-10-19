import { BadRequestException } from '@nestjs/common';

export class RescheduleAttemptsLimitReachedException extends BadRequestException {
    constructor(used: number, limit: number) {
        super({
            message: `Delivery attempts limit reached (${used} of ${limit}). The dispatch cannot be rescheduled again: it must be returned to the warehouse (returned).`,
            error:   'RESCHEDULE_ATTEMPTS_LIMIT_REACHED',
        });
    }
}
