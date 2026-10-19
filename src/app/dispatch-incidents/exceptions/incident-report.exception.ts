import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';

export class IncidentReportConflictException extends ConflictException {
    constructor(code: string, message: string) { super({ message, error: code }); }
}

export class IncidentEvidenceRequiredException extends UnprocessableEntityException {
    constructor() { super({ message: 'A photo already registered for this dispatch is required for this incident reason.', error: 'INCIDENT_EVIDENCE_REQUIRED' }); }
}

export class IncidentObservationsInvalidException extends BadRequestException {
    constructor() { super({ message: 'Observations must contain at least 10 characters for an Other incident reason.', error: 'INCIDENT_OBSERVATIONS_TOO_SHORT' }); }
}

export class IncidentCaptureTimeInvalidException extends BadRequestException {
    constructor() { super({ message: 'occurredAt must be within the last 30 days and no more than 1 hour in the future.', error: 'INCIDENT_CAPTURE_TIME_INVALID' }); }
}
