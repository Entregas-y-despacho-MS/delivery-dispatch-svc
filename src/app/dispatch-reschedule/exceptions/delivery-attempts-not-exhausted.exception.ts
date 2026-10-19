import { ConflictException } from '@nestjs/common';

export class DeliveryAttemptsNotExhaustedException extends ConflictException {
    constructor(used: number, limit: number) {
        super({
            message: `The dispatch can only be returned to the warehouse once the delivery attempts limit is reached (${used} of ${limit}). Reschedule it instead.`,
            error:   'DELIVERY_ATTEMPTS_NOT_EXHAUSTED',
        });
    }
}
