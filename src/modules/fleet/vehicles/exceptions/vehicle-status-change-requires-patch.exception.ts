import { BadRequestException } from '@nestjs/common';

export class VehicleStatusChangeRequiresPatchException extends BadRequestException {
    constructor() {
        super({
            message: 'Use PATCH /vehicles/:id/status to change a vehicle status and provide a reason.',
            error: 'VEHICLE_STATUS_CHANGE_REQUIRES_PATCH',
        });
    }
}
