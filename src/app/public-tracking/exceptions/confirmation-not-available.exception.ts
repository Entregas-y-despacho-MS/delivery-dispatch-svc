import { ConflictException } from '@nestjs/common';

/**
 * The customer cannot confirm now. `reason` is a `SelfServiceClosedReason`, `rescheduled` (the promise is already
 * firm after a rescheduling), or the cause `PromiseFirmingService` gave (`customer_response_recorded`, `order_incomplete`...).
 */
export class ConfirmationNotAvailableException extends ConflictException {
    constructor(reason: string) {
        super({ message: 'The delivery cannot be confirmed from this link.', error: 'CONFIRMATION_NOT_AVAILABLE', details: { reason } });
    }
}
