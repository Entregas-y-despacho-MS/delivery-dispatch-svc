import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RouteBatchStatusEnum } from '../../../../shared/enums/route-batch-status.enum.js';
import { RouteBatchNotFoundException } from '../exceptions/route-batch-not-found.exception.js';
import { ReassignmentTargetDto } from '../dto/reassignment-target.dto.js';
import { RouteCapacityService } from './route-capacity.service.js';

interface CandidateRow {
    route_batch_id: number;
    version: number;
    driver_id: number;
    driver_full_name: string;
    vehicle_id: number;
    vehicle_plate: string;
    zone_id: number | null;
    zone_name: string | null;
    package_count: number;
}

/**
 * ST-63.1 — candidate destinations for `POST /route-batches/:id/reassign`: the other `in_execution`
 * route batches of the same shift day, with the vehicle's remaining capacity. Read only.
 */
@Injectable()
export class ReassignmentTargetsService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly capacity: RouteCapacityService,
    ) {}

    async findTargets(originBatchId: number): Promise<ReassignmentTargetDto[]> {
        const [origin]: { shift_date: string }[] = await this.dataSource.query(
            `SELECT shift_date FROM route_batches WHERE route_batch_id = $1`,
            [originBatchId],
        );
        if (!origin) throw new RouteBatchNotFoundException();

        const candidates: CandidateRow[] = await this.dataSource.query(
            `SELECT rb.route_batch_id, rb.version, rb.driver_id, u.full_name AS driver_full_name,
                    rb.vehicle_id, v.plate AS vehicle_plate, rb.delivery_zone_id AS zone_id, dz.name AS zone_name,
                    (SELECT COUNT(*) FROM dispatch_packages p
                       JOIN dispatches d ON d.dispatch_id = p.dispatch_id
                      WHERE d.route_batch_id = rb.route_batch_id)::int AS package_count
               FROM route_batches rb
               JOIN users u ON u.user_id = rb.driver_id
               JOIN vehicles v ON v.vehicle_id = rb.vehicle_id
               LEFT JOIN delivery_zones dz ON dz.delivery_zone_id = rb.delivery_zone_id
              WHERE rb.status = $1 AND rb.shift_date = $2 AND rb.route_batch_id != $3
              ORDER BY rb.route_batch_id`,
            [RouteBatchStatusEnum.IN_EXECUTION, origin.shift_date, originBatchId],
        );

        const targets: ReassignmentTargetDto[] = [];
        for (const row of candidates) {
            const report = await this.capacity.report(row.route_batch_id, row.vehicle_id, undefined, { lock: false });
            targets.push({
                routeBatchId: row.route_batch_id,
                version: row.version,
                driverId: row.driver_id,
                driverFullName: row.driver_full_name,
                vehicleId: row.vehicle_id,
                vehiclePlate: row.vehicle_plate,
                zoneId: row.zone_id,
                zoneName: row.zone_name,
                remainingWeightKg: report.weight.remaining,
                remainingVolumeM3: report.volume.remaining,
                packageCount: row.package_count,
            });
        }
        return targets;
    }
}
