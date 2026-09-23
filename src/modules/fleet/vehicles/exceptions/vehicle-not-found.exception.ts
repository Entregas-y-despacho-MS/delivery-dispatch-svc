import { NotFoundException } from '@nestjs/common';

export class VehicleNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Vehicle not found.', error: 'VEHICLE_NOT_FOUND' });
    }
}
