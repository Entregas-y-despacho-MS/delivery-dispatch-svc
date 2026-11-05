import { BadRequestException } from '@nestjs/common';

export class RouteBatchVehicleChangeReasonRequiredException extends BadRequestException {
  constructor() {
    super({
      message: 'A reason is required when replacing the vehicle of a confirmed route batch.',
      error: 'ROUTE_BATCH_VEHICLE_CHANGE_REASON_REQUIRED',
    });
  }
}
