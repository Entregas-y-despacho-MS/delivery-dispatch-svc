import { ConflictException } from '@nestjs/common';

export interface ActiveVehicleBatch {
    id: number;
    shiftDate: string;
}

export class VehicleHasActiveBatchesException extends ConflictException {
    constructor(batches: ActiveVehicleBatch[]) {
        super({
            message: 'The vehicle cannot be moved to this status while it has confirmed or in-execution route batches.',
            error: 'VEHICLE_HAS_ACTIVE_BATCHES',
            details: { batches },
        });
    }
}
