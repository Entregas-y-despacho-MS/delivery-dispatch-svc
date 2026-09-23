import { ConflictException } from '@nestjs/common';

// RF-A30, Escenario 2 — duplicate plate.
export class VehiclePlateAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A vehicle with this plate already exists.', error: 'VEHICLE_PLATE_ALREADY_EXISTS' });
    }
}
