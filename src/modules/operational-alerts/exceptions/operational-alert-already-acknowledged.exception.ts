import { ConflictException } from '@nestjs/common';

export class OperationalAlertAlreadyAcknowledgedException extends ConflictException {
    constructor() {
        super({ message: 'This alert was already acknowledged.', error: 'OPERATIONAL_ALERT_ALREADY_ACKNOWLEDGED' });
    }
}
