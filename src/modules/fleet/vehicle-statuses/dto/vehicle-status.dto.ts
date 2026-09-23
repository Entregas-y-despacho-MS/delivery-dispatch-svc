import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class VehicleStatusDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'active', description: 'active | maintenance | out_of_service' })
    name!: string;
}
