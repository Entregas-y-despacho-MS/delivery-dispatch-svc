import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class AssignRouteBatchVehicleDto {
  @ApiProperty({
    description: 'Identifier of the vehicle to assign to the route batch.',
    type: 'integer',
    example: 8,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  vehicleId!: number;
}
