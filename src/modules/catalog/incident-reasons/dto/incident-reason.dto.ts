import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../../shared/orm/index.js';

export class IncidentReasonDto {
    @DtoField()
    @ApiProperty({ type: 'integer', example: 1, description: 'Incident reason ID. Use it as `incidentReasonId` when reporting a delivery incident (POST /sync/events)' })
    id!: number;

    @DtoField()
    @ApiProperty({ example: 'INC-CLI-AUS', description: 'Unique reference code, in uppercase. Must not belong to another reason' })
    code!: string;

    @DtoField()
    @ApiProperty({ example: 'Cliente ausente', description: 'Display name shown to the driver on the mobile app' })
    name!: string;

    @DtoField()
    @ApiProperty({ example: true, description: 'true = logging an incident with this reason requires a photo of evidence. The mobile app reads this to demand (or not) a photo before letting the driver submit the report' })
    requiresEvidence!: boolean;

    @DtoField()
    @ApiProperty({ example: true, description: 'false = disabled: cannot be assigned to new incidents. Incidents already logged with it are not affected' })
    active!: boolean;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Creation timestamp (UTC)' })
    createdAt!: Date;
}
