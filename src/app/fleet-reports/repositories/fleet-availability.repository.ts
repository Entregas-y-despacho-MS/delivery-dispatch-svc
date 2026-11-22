import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum, RouteBatchStatusEnum, VehicleStatusEnum } from '../../../shared/enums/index.js';
import type { FleetVehicleStatusRow } from '../domain/fleet-availability.js';
import type { RouteLoad } from '../domain/fleet-load.js';
import type { MaintenanceInterval } from '../domain/fleet-maintenance.js';

const CREATED_DAY = "(vm.created_at AT TIME ZONE 'America/La_Paz')::date";
const COMPLETED_DAY = "(vm.completed_at AT TIME ZONE 'America/La_Paz')::date";

export interface MaintenanceFilter {
    vehicleIds?: number[];
    maintenanceTypeId?: number;
    routine?: boolean;
}

/** Registered vehicles with their current status; the ones removed from the fleet (`deleted_at`) are not registered. */
@Injectable()
export class FleetAvailabilityRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async listRegistered(vehicleId?: number): Promise<FleetVehicleStatusRow[]> {
        const values: unknown[] = [];
        const where = vehicleId === undefined ? '' : ` AND v.vehicle_id = $${values.push(vehicleId)}`;
        const rows: Array<{ vehicle_id: number; plate: string; status: VehicleStatusEnum; capacity_kg: string; capacity_m3: string }> = await this.dataSource.query(
            `SELECT v.vehicle_id, v.plate, vs.name AS status, v.capacity_kg, v.capacity_m3
               FROM vehicles v
               JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id
              WHERE v.deleted_at IS NULL${where}
              ORDER BY v.plate, v.vehicle_id`,
            values,
        );
        return rows.map((row) => ({ vehicleId: row.vehicle_id, plate: row.plate, status: row.status, capacityKg: Number(row.capacity_kg), capacityM3: Number(row.capacity_m3) }));
    }

    /**
     * Maintenance records whose Bolivia-day interval touches `from`..`to`, as days (same day rule as ST-65.1: from the
     * creation day to the completion day; open ones have no end). `vehicleIds` limits them to the vehicles of the answer.
     */
    async listMaintenanceIntervals(from: string, to: string, filter: MaintenanceFilter): Promise<MaintenanceInterval[]> {
        const values: unknown[] = [from, to];
        let where = '';
        if (filter.vehicleIds !== undefined) where += ` AND vm.vehicle_id = ANY($${values.push(filter.vehicleIds)}::int[])`;
        if (filter.maintenanceTypeId !== undefined) where += ` AND vm.vehicle_incident_type_id = $${values.push(filter.maintenanceTypeId)}`;
        if (filter.routine === true) where += ' AND vm.vehicle_incident_type_id IS NULL';
        if (filter.routine === false) where += ' AND vm.vehicle_incident_type_id IS NOT NULL';
        const rows: Array<{ vehicle_id: number; start_day: string; end_day: string | null }> = await this.dataSource.query(
            `SELECT vm.vehicle_id,
                    to_char(${CREATED_DAY}, 'YYYY-MM-DD') AS start_day,
                    to_char(${COMPLETED_DAY}, 'YYYY-MM-DD') AS end_day
               FROM vehicle_maintenances vm
              WHERE ${CREATED_DAY} <= $2::date
                AND (vm.completed_at IS NULL OR ${COMPLETED_DAY} >= $1::date)${where}`,
            values,
        );
        return rows.map((row) => ({ vehicleId: row.vehicle_id, startDay: row.start_day, endDay: row.end_day }));
    }

    /**
     * What each approved route of the vehicles carries, for routes whose shift day is in `from`..`to`. Only routes that
     * were approved (confirmed, in execution or closed) are attributed: a provisional or pending-review route may still
     * change vehicle. Cancelled dispatches are left out. One row per route, with the sums of the estimates that exist.
     */
    async listRouteLoads(from: string, to: string, vehicleIds: number[]): Promise<RouteLoad[]> {
        const rows: Array<{ route_batch_id: number; vehicle_id: number; dispatches: number; weight_kg: string; volume_m3: string; without_weight: number; without_volume: number }> = await this.dataSource.query(
            `SELECT rb.route_batch_id, rb.vehicle_id,
                    COUNT(d.dispatch_id)::int AS dispatches,
                    COALESCE(SUM(d.estimated_weight_kg), 0) AS weight_kg,
                    COALESCE(SUM(d.estimated_volume_m3), 0) AS volume_m3,
                    COUNT(*) FILTER (WHERE d.estimated_weight_kg IS NULL)::int AS without_weight,
                    COUNT(*) FILTER (WHERE d.estimated_volume_m3 IS NULL)::int AS without_volume
               FROM route_batches rb
               JOIN dispatches d ON d.route_batch_id = rb.route_batch_id
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE rb.vehicle_id = ANY($1::int[])
                AND rb.shift_date BETWEEN $2::date AND $3::date
                AND rb.status IN ('${RouteBatchStatusEnum.CONFIRMED}', '${RouteBatchStatusEnum.IN_EXECUTION}', '${RouteBatchStatusEnum.CLOSED}')
                AND ds.name <> '${DispatchStatusEnum.CANCELLED}'
              GROUP BY rb.route_batch_id, rb.vehicle_id`,
            [vehicleIds, from, to],
        );
        return rows.map((row) => ({
            routeBatchId: row.route_batch_id,
            vehicleId: row.vehicle_id,
            dispatches: row.dispatches,
            weightKg: Number(row.weight_kg),
            volumeM3: Number(row.volume_m3),
            withoutWeight: row.without_weight,
            withoutVolume: row.without_volume,
        }));
    }
}
