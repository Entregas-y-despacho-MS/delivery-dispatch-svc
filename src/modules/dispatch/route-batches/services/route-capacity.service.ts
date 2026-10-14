import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  calculateRouteCapacity,
  type RouteCapacityDispatch,
  type RouteCapacityReport,
  type VehicleCapacity,
} from '../domain/route-capacity.js';
import { RouteCapacityExceededException } from '../exceptions/index.js';
import { VehicleNotFoundException } from '../../../fleet/vehicles/exceptions/vehicle-not-found.exception.js';

interface VehicleRow extends VehicleCapacity {
  id: number;
}

interface DispatchPackageRow {
  dispatch_id: number;
  estimated_weight_kg: string | null;
  package_id: number | null;
  length_cm: string | null;
  width_cm: string | null;
  height_cm: string | null;
  gross_weight_kg: string | null;
}

@Injectable()
export class RouteCapacityService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async report(
    routeBatchId: number,
    vehicleId: number,
    manager?: EntityManager,
  ): Promise<RouteCapacityReport> {
    const executor = manager ?? this.dataSource.manager;
    if (manager) {
      // Package consumers lock their dispatch row before changing its package set. Taking the
      // same lock keeps the measured load stable until the vehicle assignment commits.
      await manager.query(
        `SELECT dispatch_id FROM dispatches WHERE route_batch_id = $1 ORDER BY dispatch_id FOR UPDATE`,
        [routeBatchId],
      );
    }
    const vehicleLock = manager ? ' FOR UPDATE' : '';
    const [vehicle]: VehicleRow[] = await executor.query(
      `SELECT vehicle_id AS id, capacity_kg AS "capacityKg", capacity_m3 AS "capacityM3",
                    max_package_length_cm AS "maxPackageLengthCm", max_package_width_cm AS "maxPackageWidthCm",
                    max_package_height_cm AS "maxPackageHeightCm"
               FROM vehicles
              WHERE vehicle_id = $1 AND deleted_at IS NULL${vehicleLock}`,
      [vehicleId],
    );
    if (!vehicle) throw new VehicleNotFoundException();

    const rows: DispatchPackageRow[] = await executor.query(
      `SELECT d.dispatch_id, d.estimated_weight_kg, p.dispatch_package_id AS package_id,
                    p.length_cm, p.width_cm, p.height_cm, p.gross_weight_kg
               FROM dispatches d
          LEFT JOIN dispatch_packages p ON p.dispatch_id = d.dispatch_id
              WHERE d.route_batch_id = $1
              ORDER BY d.dispatch_id, p.dispatch_package_id`,
      [routeBatchId],
    );

    const dispatches = groupDispatches(rows);
    return calculateRouteCapacity(dispatches, {
      capacityKg: Number(vehicle.capacityKg),
      capacityM3: Number(vehicle.capacityM3),
      maxPackageLengthCm: numberOrNull(vehicle.maxPackageLengthCm),
      maxPackageWidthCm: numberOrNull(vehicle.maxPackageWidthCm),
      maxPackageHeightCm: numberOrNull(vehicle.maxPackageHeightCm),
    });
  }

  async assertAssignable(
    routeBatchId: number,
    vehicleId: number,
    manager?: EntityManager,
  ): Promise<RouteCapacityReport> {
    const report = await this.report(routeBatchId, vehicleId, manager);
    if (!report.assignable) throw new RouteCapacityExceededException(report);
    return report;
  }
}

function groupDispatches(rows: DispatchPackageRow[]): RouteCapacityDispatch[] {
  const dispatches = new Map<number, RouteCapacityDispatch>();
  for (const row of rows) {
    let dispatch = dispatches.get(row.dispatch_id);
    if (!dispatch) {
      dispatch = {
        dispatchId: row.dispatch_id,
        estimatedWeightKg: numberOrNull(row.estimated_weight_kg),
        packages: [],
      };
      dispatches.set(row.dispatch_id, dispatch);
    }
    if (row.package_id !== null) {
      dispatch.packages.push({
        dispatchId: row.dispatch_id,
        packageId: row.package_id,
        lengthCm: Number(row.length_cm),
        widthCm: Number(row.width_cm),
        heightCm: Number(row.height_cm),
        grossWeightKg: Number(row.gross_weight_kg),
      });
    }
  }
  return [...dispatches.values()];
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}
