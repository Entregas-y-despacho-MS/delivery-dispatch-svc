import { BadRequestException } from '@nestjs/common';

export class PickupDateInPastException extends BadRequestException {
    constructor(date: string, today: string) {
        super({
            message: `preferredPickupDate ${date} is before today (${today}, America/La_Paz).`,
            error:   'PICKUP_DATE_IN_PAST',
        });
    }
}
