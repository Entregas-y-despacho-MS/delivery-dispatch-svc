import { ConflictException } from '@nestjs/common';

/** `reason` is `not_open` (the delivery is not in a state a coordinator can still change) or `change_requested`. */
export class ChangeRequestNotAvailableException extends ConflictException {
    constructor(reason: string) {
        super({ message: 'A change cannot be requested for this delivery.', error: 'CHANGE_REQUEST_NOT_AVAILABLE', details: { reason } });
    }
}
