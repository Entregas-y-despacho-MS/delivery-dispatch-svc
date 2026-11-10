import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { INCIDENT_REASON_CODE_PATTERN } from './incident-reason-code.js';

// The code is looked up by exact value (unique index), so it is normalized the same way a plate is
// (trim + uppercase) before validation and before it ever reaches the database.
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim          = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateIncidentReasonDto {
    @ApiProperty({ example: 'INC-CLI-AUS', maxLength: 30, description: 'Unique reference code matching the outbound contract pattern. Trimmed and uppercased before validation; must not belong to another reason' })
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @Matches(INCIDENT_REASON_CODE_PATTERN, { message: 'Code must match the outbound reason-code format, e.g. INC-CLI-AUS.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code: string;

    @ApiProperty({ example: 'Cliente ausente', maxLength: 150, description: 'Display name shown to the driver on the mobile app' })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(150, { message: 'Name must not exceed 150 characters.' })
    name: string;

    @ApiProperty({ example: true, description: 'Whether logging an incident with this reason requires a photo of evidence. Required — the coordinator must decide it explicitly for every reason' })
    @IsBoolean({ message: 'Requires evidence must be true or false.' })
    requiresEvidence: boolean;

    @ApiProperty({ enum: ['low', 'high'], default: 'low', description: 'Criticality of incidents reported with this reason; only high-criticality reasons raise an ES-66 critical alert' })
    @IsOptional()
    @IsIn(['low', 'high'])
    criticality?: 'low' | 'high';
}
