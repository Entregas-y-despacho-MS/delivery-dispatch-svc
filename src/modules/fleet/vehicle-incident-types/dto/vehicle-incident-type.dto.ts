import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';

export class VehicleIncidentTypeDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Vehicle incident type ID. Use it as `vehicleIncidentTypeId` when registering a maintenance/incident on a vehicle' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'MEC-FRE-01', description: 'Unique reference code. Must not belong to another incident type' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Falla en sistema de frenos', description: 'Display name. Must not belong to another incident type' })
    name!: string;

    @DtoField()
    @ApiProperty({ enum: VehicleIncidentSeverityEnum, example: VehicleIncidentSeverityEnum.CRITICAL, description: 'Severity classification, for reporting (e.g. the mobile/web badge color)' })
    severity!: VehicleIncidentSeverityEnum;

    @DtoField()
    @ApiProperty({ example: true, description: 'Whether registering an incident of this type on a vehicle (`POST /vehicle-maintenances`) immediately sets that vehicle to `maintenance` (RF-A34, Escenario 2). Independent of `severity`' })
    disablesVehicle!: boolean;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
