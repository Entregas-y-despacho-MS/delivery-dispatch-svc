import { NotFoundException } from '@nestjs/common';

export class VehicleIncidentTypeNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Vehicle incident type not found.', error: 'VEHICLE_INCIDENT_TYPE_NOT_FOUND' });
    }
}
