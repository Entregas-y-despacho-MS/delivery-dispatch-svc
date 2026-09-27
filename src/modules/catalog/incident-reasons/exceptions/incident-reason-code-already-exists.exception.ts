import { ConflictException } from '@nestjs/common';

export class IncidentReasonCodeAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'An incident reason with this code already exists.', error: 'INCIDENT_REASON_CODE_ALREADY_EXISTS' });
    }
}
