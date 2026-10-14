import { ApiProperty } from '@nestjs/swagger';
import { RouteCapacityReportDto } from './route-capacity-report.dto.js';

export class RouteBatchVehicleAssignmentDto {
  @ApiProperty({
    description: 'Identifier of the route batch receiving the vehicle.',
    type: 'integer',
    example: 12,
  })
  routeBatchId!: number;

  @ApiProperty({
    description: 'Identifier of the assigned vehicle.',
    type: 'integer',
    example: 8,
  })
  vehicleId!: number;

  @ApiProperty({
    description: 'Route load totals and the vehicle capacity check.',
    type: () => RouteCapacityReportDto,
  })
  capacity!: RouteCapacityReportDto;
}
