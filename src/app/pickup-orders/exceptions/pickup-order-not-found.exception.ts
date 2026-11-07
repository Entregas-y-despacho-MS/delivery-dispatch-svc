import { NotFoundException } from '@nestjs/common';

export class PickupOrderNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Pickup order not found.', error: 'PICKUP_ORDER_NOT_FOUND' });
    }
}
