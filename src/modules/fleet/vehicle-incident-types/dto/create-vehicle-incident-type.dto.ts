import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// The code is looked up by exact value (unique index), same normalization as incident_reasons/reschedule_reasons.
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class CreateVehicleIncidentTypeDto {
    @ApiProperty({ example: 'MEC-FRE-01', maxLength: 30, description: 'Unique reference code. Trimmed and uppercased before validation; must not belong to another incident type' })
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code: string;

    @ApiProperty({ example: 'Falla en sistema de frenos', maxLength: 100, description: 'Display name. Trimmed; must not belong to another incident type' })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name: string;

    // RF-A34, Escenario 3 — no default: the supervisor must classify criticality explicitly.
    @ApiProperty({ enum: VehicleIncidentSeverityEnum, example: VehicleIncidentSeverityEnum.CRITICAL, description: 'Severity classification. Required — must be classified explicitly' })
    @IsEnum(VehicleIncidentSeverityEnum, { message: 'Severity must be one of: minor, moderate, critical.' })
    severity: VehicleIncidentSeverityEnum;

    @ApiProperty({ example: true, description: 'Whether registering an incident of this type on a vehicle immediately sets it to `maintenance`. Required — the supervisor must decide it explicitly for every type' })
    @IsBoolean({ message: 'Disables vehicle must be true or false.' })
    disablesVehicle: boolean;
}
