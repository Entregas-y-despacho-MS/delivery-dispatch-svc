import { ConflictException } from '@nestjs/common';

export class PickupWindowNotAvailableException extends ConflictException {
    constructor() {
        super({
            message: 'The requested pickup window does not fall inside the supplier window and the warehouse reception hours.',
            error:   'PICKUP_WINDOW_NOT_AVAILABLE',
        });
    }
}
