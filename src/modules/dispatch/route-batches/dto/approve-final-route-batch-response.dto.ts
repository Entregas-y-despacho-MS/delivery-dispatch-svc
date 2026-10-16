import { ApiProperty } from '@nestjs/swagger';

export class ApproveFinalRouteBatchResponseDto {
  @ApiProperty({ example: 7, description: 'ID of the route batch that was finally approved.' })
  routeBatchId!: number;

  @ApiProperty({ example: 5, description: 'Route-batch planning version after final approval.' })
  version!: number;

  @ApiProperty({ example: 14, description: 'Active driver assigned to the confirmed route batch.' })
  driverId!: number;

  @ApiProperty({ example: 3, description: 'Active vehicle assigned to the confirmed route batch.' })
  vehicleId!: number;

  @ApiProperty({ type: [Number], example: [42, 43], description: 'Dispatch IDs assigned atomically with the confirmed batch.' })
  dispatchIds!: number[];
}
