import { ConflictException } from '@nestjs/common';

// Covers a collision on either `name` or `code` — same simplification already accepted in
// incident_reasons/reschedule_reasons: the DB's unique indexes don't say which of the two collided.
export class VehicleIncidentTypeCodeAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A vehicle incident type with this name or code already exists.', error: 'VEHICLE_INCIDENT_TYPE_CODE_ALREADY_EXISTS' });
    }
}
