import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export class AssignRouteBatchDriverDto {
  @ApiProperty({
    description: 'Identifier of the user, with the driver role, to propose for the route batch. Must be active and have no other live route batch that day.',
    type: 'integer',
    example: 34,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  @Max(INT4_MAX)
  driverId!: number;

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
}
