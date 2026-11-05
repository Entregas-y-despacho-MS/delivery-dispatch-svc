import { BadRequestException } from '@nestjs/common';

export class InvalidMaintenanceDateRangeException extends BadRequestException {
    constructor() {
        super({ message: "The 'from' date must not be after the 'to' date.", error: 'INVALID_MAINTENANCE_DATE_RANGE' });
    }
}
