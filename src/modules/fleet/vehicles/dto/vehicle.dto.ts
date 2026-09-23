import { ApiProperty } from '@nestjs/swagger';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { VehicleStatusDto } from '../../vehicle-statuses/dto/vehicle-status.dto.js';

export class VehicleDto {
    @DtoField()
    @ApiProperty({ example: 1 })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'camioneta' })
    type!: string;

    @DtoField()
    @ApiProperty({ example: 'Toyota Hilux 2022' })
    model!: string;

    @DtoField()
    @ApiProperty({ example: '1234-ABC' })
    plate!: string;

    @DtoField()
    @ApiProperty({ example: 1200.5, description: 'Maximum load weight, in kg' })
    capacityKg!: number;

    @DtoField()
    @ApiProperty({ example: 8.5, description: 'Maximum load volume, in m3' })
    capacityM3!: number;

    @DtoRelation(() => VehicleStatusDto)
    @ApiProperty({ type: () => VehicleStatusDto })
    vehicleStatus!: VehicleStatusDto;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    createdAt!: Date;
}
