import { NotFoundException } from '@nestjs/common';

export class IncidentReasonNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Incident reason not found.', error: 'INCIDENT_REASON_NOT_FOUND' });
    }
}
