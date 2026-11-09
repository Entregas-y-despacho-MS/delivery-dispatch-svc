import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface VehicleMaintenancePeriod {
    vehicleId: number;
    maintenanceCount: number;
    daysInMaintenance: number;
}

const CREATED_DAY = "(created_at AT TIME ZONE 'America/La_Paz')::date";
const COMPLETED_DAY = "(completed_at AT TIME ZONE 'America/La_Paz')::date";

/** Aggregates maintenance records whose calendar-day interval overlaps the requested inclusive range. */
@Injectable()
export class FleetMaintenanceReportRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async aggregate(from: string, to: string): Promise<VehicleMaintenancePeriod[]> {
        const rows: Array<{ vehicle_id: number; maintenance_count: number; days_in_maintenance: number }> = await this.dataSource.query(
            `SELECT vehicle_id,
                    COUNT(*)::int AS maintenance_count,
                    COALESCE(SUM(
                        LEAST(COALESCE(${COMPLETED_DAY}, $2::date), $2::date)
                        - GREATEST(${CREATED_DAY}, $1::date) + 1
                    ), 0)::int AS days_in_maintenance
               FROM vehicle_maintenances
              WHERE ${CREATED_DAY} <= $2::date
                AND (completed_at IS NULL OR ${COMPLETED_DAY} >= $1::date)
              GROUP BY vehicle_id`,
            [from, to],
        );
        return rows.map((row) => ({ vehicleId: row.vehicle_id, maintenanceCount: row.maintenance_count, daysInMaintenance: row.days_in_maintenance }));
    }
}
