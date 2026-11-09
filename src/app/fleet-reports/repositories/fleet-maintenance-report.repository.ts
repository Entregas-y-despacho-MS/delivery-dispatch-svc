import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface VehicleMaintenancePeriod {
    vehicleId: number;
    vehiclePlate: string | null;
    maintenanceCount: number;
    daysInMaintenance: number;
}

const CREATED_DAY = "(vm.created_at AT TIME ZONE 'America/La_Paz')::date";
const COMPLETED_DAY = "(vm.completed_at AT TIME ZONE 'America/La_Paz')::date";

/** Aggregates maintenance records whose calendar-day interval overlaps the requested inclusive range. */
@Injectable()
export class FleetMaintenanceReportRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async aggregate(from: string, to: string): Promise<VehicleMaintenancePeriod[]> {
        const rows: Array<{ vehicle_id: number; vehicle_plate: string | null; maintenance_count: number; days_in_maintenance: number }> = await this.dataSource.query(
            `SELECT vm.vehicle_id, v.plate AS vehicle_plate,
                    COUNT(*)::int AS maintenance_count,
                    COALESCE(SUM(
                        LEAST(COALESCE(${COMPLETED_DAY}, $2::date), $2::date)
                        - GREATEST(${CREATED_DAY}, $1::date) + 1
                    ), 0)::int AS days_in_maintenance
               FROM vehicle_maintenances vm
               LEFT JOIN vehicles v ON v.vehicle_id = vm.vehicle_id
              WHERE ${CREATED_DAY} <= $2::date
                AND (vm.completed_at IS NULL OR ${COMPLETED_DAY} >= $1::date)
              GROUP BY vm.vehicle_id, v.plate`,
            [from, to],
        );
        return rows.map((row) => ({ vehicleId: row.vehicle_id, vehiclePlate: row.vehicle_plate, maintenanceCount: row.maintenance_count, daysInMaintenance: row.days_in_maintenance }));
    }
}
