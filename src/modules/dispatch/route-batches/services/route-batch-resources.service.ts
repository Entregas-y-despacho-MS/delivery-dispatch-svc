import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RoleEnum, RouteBatchStatusEnum, VehicleStatusEnum } from '../../../../shared/enums/index.js';
import { RouteBatchApprovalConflictException } from '../exceptions/route-batch-approval-conflict.exception.js';

/**
 * Rules for the driver and the vehicle of a route batch, shared by the 2nd approval (ST-51.2) and the
 * correction of a batch (ST-51.6). Every check runs under the caller's transaction and locks what it reads,
 * so two coordinators cannot take the same driver or vehicle on the same day.
 */
@Injectable()
export class RouteBatchResourcesService {
  /** The vehicle exists, is not deleted and is `active`. */
  async assertVehicleActive(manager: EntityManager, vehicleId: number): Promise<void> {
    const [vehicle]: { id: number }[] = await manager.query(
      `SELECT v.vehicle_id AS id
         FROM vehicles v JOIN vehicle_statuses s ON s.vehicle_status_id = v.vehicle_status_id
        WHERE v.vehicle_id = $1 AND v.deleted_at IS NULL AND s.name = $2
        FOR UPDATE OF v`,
      [vehicleId, VehicleStatusEnum.ACTIVE],
    );
    if (!vehicle) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_VEHICLE_NOT_ACTIVE', `Vehicle ${vehicleId} is not active.`);
    }
  }

  /** The driver is an active user with the driver role and no other live batch that day (assigned or proposed). */
  async assertDriverAvailable(manager: EntityManager, driverId: number, shiftDate: string, routeBatchId: number): Promise<void> {
    const [driver]: { id: number }[] = await manager.query(
      `SELECT u.user_id AS id
         FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = $1 AND u.active = TRUE AND u.deleted_at IS NULL AND r.name = $2
        FOR UPDATE OF u`,
      [driverId, RoleEnum.DRIVER],
    );
    if (!driver) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_NOT_AVAILABLE', `Driver ${driverId} is inactive or is not a driver.`);
    }
    const conflicts: { route_batch_id: number }[] = await manager.query(
      `SELECT route_batch_id
         FROM route_batches
        WHERE route_batch_id <> $1 AND shift_date = $2 AND status NOT IN ($3, $4)
          AND (driver_id = $5 OR proposed_driver_id = $5)
        ORDER BY route_batch_id
        FOR UPDATE`,
      [routeBatchId, shiftDate, RouteBatchStatusEnum.CANCELLED, RouteBatchStatusEnum.CLOSED, driverId],
    );
    if (conflicts.length > 0) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_NOT_AVAILABLE', `Driver ${driverId} is already assigned or proposed for route batch ${conflicts[0].route_batch_id} on ${shiftDate}.`);
    }
  }

  /** No other live batch that day holds this vehicle or this driver (`null`: the batch has no driver yet). */
  async assertResourcesAvailable(manager: EntityManager, driverId: number | null, vehicleId: number, shiftDate: string, routeBatchId: number): Promise<void> {
    const conflicts: { route_batch_id: number; driver_id: number | null; vehicle_id: number | null }[] = await manager.query(
      `SELECT route_batch_id, driver_id, vehicle_id
         FROM route_batches
        WHERE route_batch_id <> $1 AND shift_date = $2 AND status NOT IN ($3, $4)
          AND (driver_id = $5 OR vehicle_id = $6)
        ORDER BY route_batch_id
        FOR UPDATE`,
      [routeBatchId, shiftDate, RouteBatchStatusEnum.CANCELLED, RouteBatchStatusEnum.CLOSED, driverId, vehicleId],
    );
    const conflict = conflicts[0];
    if (conflict?.vehicle_id === vehicleId) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_RESOURCE_CONFLICT', `Vehicle ${vehicleId} is already assigned to route batch ${conflict.route_batch_id} on ${shiftDate}.`);
    }
    if (driverId !== null && conflict?.driver_id === driverId) {
      throw new RouteBatchApprovalConflictException('ROUTE_BATCH_DRIVER_NOT_AVAILABLE', `Driver ${driverId} is already assigned to route batch ${conflict.route_batch_id} on ${shiftDate}.`);
    }
  }
}
