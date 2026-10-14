import { ApiProperty } from '@nestjs/swagger';
import type { RouteCapacityReport } from '../domain/route-capacity.js';

export class RouteBatchVehicleAssignmentDto {
    @ApiProperty({ type: 'integer', example: 12 })
    routeBatchId: number;

    @ApiProperty({ type: 'integer', example: 8 })
    vehicleId: number;

    @ApiProperty({ description: 'Route load totals and the vehicle capacity check.' })
    capacity: RouteCapacityReport;
}
