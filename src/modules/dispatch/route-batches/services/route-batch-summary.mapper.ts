import type { RouteBatch } from '../entities/route-batch.entity.js';
import type { RouteBatchOccupancy } from '../domain/route-batch-view.js';
import type { RouteBatchSummaryDto } from '../dto/route-batch-summary.dto.js';

/** Builds the row shown in the list (and the head of the detail) from a batch loaded with its relations. */
export function toSummary(
  batch: RouteBatch,
  dispatchCount: number,
  occupancy: RouteBatchOccupancy | null,
): RouteBatchSummaryDto {
  return {
    id: batch.id,
    status: batch.status,
    version: batch.version,
    shiftDate: batch.shiftDate,
    zone: batch.deliveryZone
      ? { id: batch.deliveryZone.id, code: batch.deliveryZone.code, name: batch.deliveryZone.name }
      : null,
    vehicle: batch.vehicle
      ? { id: batch.vehicle.id, plate: batch.vehicle.plate, model: batch.vehicle.model, type: batch.vehicle.type }
      : null,
    proposedDriver: batch.proposedDriver
      ? { id: batch.proposedDriver.id, fullName: batch.proposedDriver.fullName }
      : null,
    reviewer: batch.reviewerUser
      ? { id: batch.reviewerUser.id, fullName: batch.reviewerUser.fullName }
      : null,
    dispatchCount,
    occupancy,
  };
}
