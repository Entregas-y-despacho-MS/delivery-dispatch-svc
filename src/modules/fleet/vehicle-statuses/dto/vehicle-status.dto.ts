import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class VehicleStatusDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Status ID: 1 = active, 2 = maintenance, 3 = out_of_service. Use it as `vehicleStatusId`' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'active', enum: ['active', 'maintenance', 'out_of_service'], description: 'active = available for route assignment · maintenance = temporarily unavailable · out_of_service = withdrawn' })
    name!: string;
}
