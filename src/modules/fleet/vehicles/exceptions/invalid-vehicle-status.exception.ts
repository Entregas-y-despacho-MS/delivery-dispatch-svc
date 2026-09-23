import { BadRequestException } from '@nestjs/common';

export class InvalidVehicleStatusException extends BadRequestException {
    constructor() {
        super({ message: 'The given vehicle status does not exist.', error: 'INVALID_VEHICLE_STATUS' });
    }
}
