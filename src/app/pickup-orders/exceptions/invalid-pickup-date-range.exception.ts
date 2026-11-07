import { BadRequestException } from '@nestjs/common';

export class InvalidPickupDateRangeException extends BadRequestException {
    constructor() {
        super({ message: "The 'to' date must not be before the 'from' date.", error: 'INVALID_PICKUP_DATE_RANGE' });
    }
}
