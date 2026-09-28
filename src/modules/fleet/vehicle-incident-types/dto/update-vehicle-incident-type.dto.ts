import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { VehicleIncidentSeverityEnum } from '../../../../shared/enums/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class UpdateVehicleIncidentTypeDto {
    @ApiPropertyOptional({ example: 'MEC-FRE-01', maxLength: 30, description: 'New reference code. Trimmed and uppercased before validation; must not belong to another incident type. null is rejected' })
    @OptionalNotNull()
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code must not be empty.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Falla en sistema de frenos', maxLength: 100, description: 'New display name. Must not belong to another incident type. null is rejected' })
    @OptionalNotNull()
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name must not be empty.' })
    @MaxLength(100, { message: 'Name must not exceed 100 characters.' })
    name?: string;

    @ApiPropertyOptional({ enum: VehicleIncidentSeverityEnum, example: VehicleIncidentSeverityEnum.MODERATE, description: 'New severity classification. null is rejected' })
    @OptionalNotNull()
    @IsEnum(VehicleIncidentSeverityEnum, { message: 'Severity must be one of: minor, moderate, critical.' })
    severity?: VehicleIncidentSeverityEnum;

    @ApiPropertyOptional({ example: false, description: 'New disablesVehicle value. null is rejected' })
    @OptionalNotNull()
    @IsBoolean({ message: 'Disables vehicle must be true or false.' })
    disablesVehicle?: boolean;
}
