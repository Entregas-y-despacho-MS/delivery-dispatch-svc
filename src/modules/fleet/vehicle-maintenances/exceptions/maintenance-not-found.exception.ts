import { NotFoundException } from '@nestjs/common';

export class MaintenanceNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Vehicle maintenance not found.', error: 'VEHICLE_MAINTENANCE_NOT_FOUND' });
    }
}
