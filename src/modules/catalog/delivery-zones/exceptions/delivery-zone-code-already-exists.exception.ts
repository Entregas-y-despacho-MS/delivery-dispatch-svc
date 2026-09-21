import { ConflictException } from '@nestjs/common';

// RF-A29, Escenario 2 — colisión de código de zona.
export class DeliveryZoneCodeAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'This code already belongs to another delivery zone.', error: 'DELIVERY_ZONE_CODE_ALREADY_EXISTS' });
    }
}
