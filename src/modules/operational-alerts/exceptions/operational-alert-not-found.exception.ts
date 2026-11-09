import { NotFoundException } from '@nestjs/common';

export class OperationalAlertNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Operational alert not found.', error: 'OPERATIONAL_ALERT_NOT_FOUND' });
    }
}
