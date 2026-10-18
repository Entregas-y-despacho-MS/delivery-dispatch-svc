import { ConflictException } from '@nestjs/common';

/**
 * The slot the customer chose cannot be taken any more: another order took the room, the batch changed, or the
 * delivery itself moved while the page was open. Nothing was changed; the page lists the slots again.
 */
export class SlotNoLongerAvailableException extends ConflictException {
    constructor() {
        super({ message: 'That slot is no longer available. Choose another one.', error: 'SLOT_NO_LONGER_AVAILABLE' });
    }
}
