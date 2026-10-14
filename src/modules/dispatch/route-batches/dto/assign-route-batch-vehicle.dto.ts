import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class AssignRouteBatchVehicleDto {
    @ApiProperty({ type: 'integer', example: 8, minimum: 1 })
    @IsInt()
    @Min(1)
    vehicleId: number;
}
