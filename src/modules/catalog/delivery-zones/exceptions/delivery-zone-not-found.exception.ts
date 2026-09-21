import { NotFoundException } from '@nestjs/common';

export class DeliveryZoneNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Delivery zone not found.', error: 'DELIVERY_ZONE_NOT_FOUND' });
    }
}
