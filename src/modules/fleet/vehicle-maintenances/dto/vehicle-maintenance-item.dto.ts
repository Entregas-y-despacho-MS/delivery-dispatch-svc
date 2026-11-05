import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { DtoField, DtoRelation } from '../../../../shared/orm/index.js';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { MaintenanceStatusEnum } from '../../../../shared/enums/index.js';

export class MaintenanceVehicleDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 7, description: 'Vehicle ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: '1234-ABC', description: 'License plate' })
    plate!: string;

    @DtoField()
    @ApiProperty({ example: 'Toyota Hilux 2022', description: 'Make and model' })
    model!: string;
}

export class MaintenanceIncidentTypeDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 3, description: 'Incident type ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'MEC-FRE-01', description: 'Incident type code' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Falla en sistema de frenos', description: 'Incident type name' })
    name!: string;
}

@ApiExtraModels(MaintenanceIncidentTypeDto)
export class VehicleMaintenanceItemDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Maintenance record ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 7, description: 'Vehicle ID' })
    vehicleId!: number;

    @DtoRelation(() => MaintenanceVehicleDto)
    @ApiProperty({ type: () => MaintenanceVehicleDto, description: 'The vehicle, even if it was removed later (the history keeps it)' })
    vehicle!: MaintenanceVehicleDto;

    @DtoField()
    @ApiProperty({ type: 'integer', nullable: true, example: 3, description: 'Incident type; null for a routine (preventive) maintenance' })
    vehicleIncidentTypeId!: number | null;

    @DtoRelation(() => MaintenanceIncidentTypeDto)
    @ApiProperty({ allOf: [{ $ref: getSchemaPath(MaintenanceIncidentTypeDto) }], nullable: true, description: 'Incident type detail; null if there is none or the type was removed from the catalog' })
    vehicleIncidentType!: MaintenanceIncidentTypeDto | null;

    // Derived, not a column: set by VehicleMaintenancesService.findAll().
    @ApiProperty({ enum: ['preventive', 'corrective'], example: 'corrective', description: '`corrective` when the maintenance comes from an incident type, `preventive` when it has none' })
    maintenanceType!: 'preventive' | 'corrective';

    @DtoField()
    @ApiProperty({ example: 'Se sintió ruido metálico en las pastillas de freno delanteras', description: 'Free-text detail of what happened' })
    description!: string;

    @DtoField()
    @ApiProperty({ enum: MaintenanceStatusEnum, example: 'in_progress', description: 'pending, in_progress or completed' })
    status!: string;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-10T14:00:00.000Z', description: 'Scheduled date (UTC), if any' })
    scheduledAt!: Date | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', nullable: true, example: '2026-11-04T18:30:00.000Z', description: 'Closing date (UTC); null until the maintenance is completed' })
    completedAt!: Date | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2026-11-01T00:00:00.000Z', description: 'Registration timestamp (UTC)' })
    createdAt!: Date;
}

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindVehicleMaintenancesResponseDto extends PaginationResponseDto<VehicleMaintenanceItemDto> {
    @ApiProperty({ type: [VehicleMaintenanceItemDto] })
    declare data: VehicleMaintenanceItemDto[];
}
