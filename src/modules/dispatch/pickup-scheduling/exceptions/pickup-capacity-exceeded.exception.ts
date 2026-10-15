import { ConflictException } from '@nestjs/common';

export class PickupCapacityExceededException extends ConflictException {
    constructor(detail: string) {
        super({
            message: `The estimated load exceeds the vehicle capacity: ${detail}.`,
            error:   'PICKUP_CAPACITY_EXCEEDED',
        });
    }
}
