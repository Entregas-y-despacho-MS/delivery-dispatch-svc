import { ConflictException } from '@nestjs/common';

export class RouteBatchVehicleAssignmentNotAllowedException extends ConflictException {
  constructor(status: string) {
    super({
      message: `A vehicle can only be assigned while the route batch is provisional (current status: ${status}).`,
      error: 'ROUTE_BATCH_NOT_PROVISIONAL',
    });
  }
}
