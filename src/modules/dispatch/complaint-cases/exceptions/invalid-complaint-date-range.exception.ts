import { BadRequestException } from '@nestjs/common';

export class InvalidComplaintDateRangeException extends BadRequestException {
    constructor() {
        super({ message: "The 'from' date must not be after the 'to' date.", error: 'INVALID_DATE_RANGE' });
    }
}
