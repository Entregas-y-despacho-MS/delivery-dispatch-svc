import { ConflictException } from '@nestjs/common';

// Covers a collision on either `name` or `code` (RF-A33, Escenario 3: "nombre o código") — same
// simplification already accepted in incident_reasons: the DB's unique indexes don't say which of
// the two collided, so neither does this.
export class RescheduleReasonCodeAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A reschedule reason with this name or code already exists.', error: 'RESCHEDULE_REASON_CODE_ALREADY_EXISTS' });
    }
}
