import { ConflictException } from '@nestjs/common';
import type { RouteCapacityReport } from '../domain/route-capacity.js';

export class RouteCapacityExceededException extends ConflictException {
  constructor(report: RouteCapacityReport) {
    super({
      error: 'ROUTE_CAPACITY_EXCEEDED',
      message:
        'The route cannot be assigned to this vehicle because its cargo exceeds the vehicle capacity or package dimensions.',
      details: report,
    });
  }
}
