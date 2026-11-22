import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import type { FleetVehicleStatusRow } from '../domain/fleet-availability.js';
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
        const rows: Array<{ vehicle_id: number; plate: string; status: VehicleStatusEnum }> = await this.dataSource.query(
            `SELECT v.vehicle_id, v.plate, vs.name AS status
               FROM vehicles v
               JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id
              WHERE v.deleted_at IS NULL${where}
              ORDER BY v.plate, v.vehicle_id`,
            values,
        );
        return rows.map((row) => ({ vehicleId: row.vehicle_id, plate: row.plate, status: row.status }));
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
}
