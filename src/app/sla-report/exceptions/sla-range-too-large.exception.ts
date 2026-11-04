import { BadRequestException } from '@nestjs/common';

export class SlaRangeTooLargeException extends BadRequestException {
    constructor(maxDays: number) {
        super({ message: `The date range must not exceed ${maxDays} days.`, error: 'DATE_RANGE_TOO_LARGE' });
    }
}
