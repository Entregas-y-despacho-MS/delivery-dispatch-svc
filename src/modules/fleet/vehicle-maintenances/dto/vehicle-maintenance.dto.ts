import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class VehicleMaintenanceDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Maintenance/incident record ID' })
    id!: number;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 7, description: 'Vehicle this record is about' })
    vehicleId!: number;

    @DtoField()
    @ApiProperty({ type: 'integer', example: 3, description: 'Vehicle incident type registered' })
    vehicleIncidentTypeId!: number;

    @DtoField()
    @ApiProperty({ example: 'Se sintió ruido metálico en las pastillas de freno delanteras', description: 'Free-text detail of what happened' })
    description!: string;

    @DtoField()
    @ApiProperty({ example: 'pending', description: 'pending, in_progress or completed — always pending right after registering (RF-A17 tracks it from here on, out of scope of this endpoint)' })
    status!: string;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;

    // Not a @DtoField — this is the vehicle's own current status (from `vehicles`, not a column of
    // this table), attached by the controller right after the write so the caller sees the effect
    // of the trigger (RF-A34, Escenario 2) without a second request.
    @ApiProperty({ example: 'maintenance', description: 'The vehicle\'s current operational status, right after this write — `maintenance` if the incident type\'s `disablesVehicle` was true, unchanged otherwise' })
    vehicleStatus!: string;
}
