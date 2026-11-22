import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { DispatchStatusEnum, RouteBatchStatusEnum, VehicleStatusEnum } from '../../../shared/enums/index.js';
import { SLA_CLOSED_STATUSES } from '../../sla-report/repositories/sla-report.repository.js';
import type { FleetVehicleStatusRow } from '../domain/fleet-availability.js';
import type { RouteLoad } from '../domain/fleet-load.js';
import type { MaintenanceInterval } from '../domain/fleet-maintenance.js';
import type { DriverProductivityRow } from '../domain/fleet-productivity.js';

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

    /**
     * Delivery dispatches closed in the Bolivia days `from`..`to`, by the driver of their route. «Closed» means what it
     * means for the SLA report (ST-54.2): terminal statuses but cancelled. A dispatch without driver comes with a null
     * `driverId`. `vehicleId` / `driverId` narrow it to the routes of that vehicle or driver.
     */
    async listDriverProductivity(from: string, to: string, filter: { vehicleId?: number; driverId?: number }): Promise<DriverProductivityRow[]> {
        const values: unknown[] = [from, to];
        let where = '';
        if (filter.vehicleId !== undefined) where += ` AND rb.vehicle_id = $${values.push(filter.vehicleId)}`;
        if (filter.driverId !== undefined) where += ` AND rb.driver_id = $${values.push(filter.driverId)}`;
        const closed = SLA_CLOSED_STATUSES.map((status) => `'${status}'`).join(', ');
        const rows: Array<{ driver_id: number | null; driver_name: string | null; closed_count: number; delivered_count: number }> = await this.dataSource.query(
            `SELECT rb.driver_id, u.full_name AS driver_name,
                    COUNT(*)::int AS closed_count,
                    COUNT(*) FILTER (WHERE s.name = '${DispatchStatusEnum.DELIVERED}')::int AS delivered_count
               FROM dispatches d
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id AND t.name = 'delivery'
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
               LEFT JOIN users u ON u.user_id = rb.driver_id
              WHERE s.name IN (${closed})
                AND d.closed_at IS NOT NULL
                AND d.closed_at >= ($1::date)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}'
                AND d.closed_at < (($2::date + 1)::timestamp AT TIME ZONE '${OPERATING_TIME_ZONE}')${where}
              GROUP BY rb.driver_id, u.full_name
              ORDER BY u.full_name NULLS LAST, rb.driver_id`,
            values,
        );
        return rows.map((row) => ({ driverId: row.driver_id, driverName: row.driver_name, closedCount: row.closed_count, deliveredCount: row.delivered_count }));
    }
}
