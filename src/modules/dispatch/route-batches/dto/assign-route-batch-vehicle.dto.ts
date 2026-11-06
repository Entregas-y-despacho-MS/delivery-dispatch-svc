import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export class AssignRouteBatchVehicleDto {
  @ApiProperty({
    description: 'Identifier of the vehicle to assign to the route batch.',
    type: 'integer',
    example: 8,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  vehicleId!: number;

  @ApiProperty({
    description: 'Planning version of the route batch the caller reviewed (the `version` of `GET /route-batches/:id`). A different current version answers 409 `ROUTE_BATCH_VERSION_CONFLICT`.',
    type: 'integer',
    example: 4,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(INT4_MAX)
  version!: number;

  @ApiProperty({
    description: 'Reason for the vehicle change. Required when the batch is already confirmed; optional for provisional or pending-final-review batches for backwards compatibility.',
    example: 'Vehicle reported a mechanical fault before dispatch.',
    maxLength: 500,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
