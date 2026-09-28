import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsPositive, IsString, Max, MaxLength } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateVehicleMaintenanceDto {
    @ApiProperty({ type: 'integer', example: 7, description: 'Vehicle the incident happened to' })
    @IsInt()
    @IsPositive()
    @Max(INT4_MAX)
    vehicleId: number;

    // Required here (unlike the column itself, which allows NULL for a routine maintenance with no
    // incident) — this endpoint is specifically for registering an incident (RF-A34, Escenario 1/2),
    // not RF-A17's broader "schedule routine maintenance" case.
    @ApiProperty({ type: 'integer', example: 3, description: 'Vehicle incident type that happened. Required — this endpoint is for registering an incident, not a routine maintenance' })
    @IsInt()
    @IsPositive()
    @Max(INT4_MAX)
    vehicleIncidentTypeId: number;

    @ApiProperty({ example: 'Se sintió ruido metálico en las pastillas de freno delanteras', maxLength: 1000, description: 'Free-text detail of what happened. Trimmed' })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Description is required.' })
    @MaxLength(1000, { message: 'Description must not exceed 1000 characters.' })
    description: string;
}
