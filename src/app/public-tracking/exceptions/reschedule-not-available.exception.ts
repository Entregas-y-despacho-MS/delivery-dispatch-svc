import { ConflictException } from '@nestjs/common';

/** Why the rescheduling cannot start: a `SelfServiceClosedReason`, `no_contact_email` or `not_configured`. */
export class RescheduleNotAvailableException extends ConflictException {
    constructor(reason: string) {
        super({ message: 'Rescheduling is not available for this delivery.', error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason } });
    }
}
