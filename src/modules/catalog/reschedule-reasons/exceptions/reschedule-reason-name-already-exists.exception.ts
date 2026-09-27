import { ConflictException } from '@nestjs/common';

export class RescheduleReasonNameAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A reschedule reason with this name already exists.', error: 'RESCHEDULE_REASON_NAME_ALREADY_EXISTS' });
    }
}
