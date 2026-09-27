import { NotFoundException } from '@nestjs/common';

export class RescheduleReasonNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Reschedule reason not found.', error: 'RESCHEDULE_REASON_NOT_FOUND' });
    }
}
