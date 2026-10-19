import { BadRequestException } from '@nestjs/common';

export class RescheduleReasonInvalidException extends BadRequestException {
    constructor(code: string) {
        super({
            message: `The reschedule reason '${code}' does not exist or is not active.`,
            error:   'RESCHEDULE_REASON_INVALID',
        });
    }
}
