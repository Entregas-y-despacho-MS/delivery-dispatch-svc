import { Injectable, ConflictException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RouteBatchVehicleAssignmentDto } from '../dto/route-batch-vehicle-assignment.dto.js';
import { RouteBatchNotFoundException } from '../exceptions/index.js';
import { RouteCapacityService } from './route-capacity.service.js';

@Injectable()
export class RouteBatchVehicleService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly capacity: RouteCapacityService,
    ) {}

    async assign(routeBatchId: number, vehicleId: number): Promise<RouteBatchVehicleAssignmentDto> {
        return await this.dataSource.transaction(async (manager) => {
            const [batch]: { id: number; status: string }[] = await manager.query(
                `SELECT route_batch_id AS id, status FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
                [routeBatchId],
            );
            if (!batch) throw new RouteBatchNotFoundException();
            if (batch.status !== 'provisional') {
                throw new ConflictException({
                    error: 'ROUTE_BATCH_NOT_PROVISIONAL',
                    message: `A vehicle can only be assigned while the route batch is provisional (current status: ${batch.status}).`,
                });
            }

            const capacity = await this.capacity.assertAssignable(routeBatchId, vehicleId, manager);
            await manager.query(
                `UPDATE route_batches SET vehicle_id = $2, updated_at = NOW() WHERE route_batch_id = $1`,
                [routeBatchId, vehicleId],
            );

            return { routeBatchId, vehicleId, capacity };
        });
    }
}
