import { ApiProperty } from '@nestjs/swagger';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { VehicleStatusDto } from '../../vehicle-statuses/dto/vehicle-status.dto.js';

export class VehicleDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Vehicle ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'camioneta', description: 'Kind of vehicle' })
    type!: string;

    @DtoField()
    @ApiProperty({ example: 'Toyota Hilux 2022', description: 'Make and model' })
    model!: string;

    @DtoField()
    @ApiProperty({ example: '1234-ABC', description: 'License plate, uppercase, unique among vehicles' })
    plate!: string;

    @DtoField()
    @ApiProperty({ type: 'number', format: 'double', example: 1200.5, description: 'Maximum load weight, in kg' })
    capacityKg!: number;

    @DtoField()
    @ApiProperty({ type: 'number', format: 'double', example: 8.5, description: 'Maximum load volume, in m3' })
    capacityM3!: number;

    @DtoRelation(() => VehicleStatusDto)
    @ApiProperty({ type: () => VehicleStatusDto, description: 'Current operational status' })
    vehicleStatus!: VehicleStatusDto;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
