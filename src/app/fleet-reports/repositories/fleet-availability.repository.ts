import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VehicleStatusEnum } from '../../../shared/enums/index.js';
import type { FleetVehicleStatusRow } from '../domain/fleet-availability.js';

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
}
