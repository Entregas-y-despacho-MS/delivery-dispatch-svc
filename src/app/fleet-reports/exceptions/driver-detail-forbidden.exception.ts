import { ForbiddenException } from '@nestjs/common';

export class DriverDetailForbiddenException extends ForbiddenException {
    constructor() {
        super({ message: 'Your role may only see aggregated driver figures; the driver filter is not allowed.', error: 'DRIVER_DETAIL_FORBIDDEN' });
    }
}
