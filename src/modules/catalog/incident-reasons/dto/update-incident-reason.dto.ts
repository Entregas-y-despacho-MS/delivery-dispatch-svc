import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';

const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim          = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateIncidentReasonDto {
    @ApiPropertyOptional({ example: 'INC-CLI-AUS', maxLength: 30, description: 'New code. Must not belong to another reason. null is rejected' })
    @OptionalNotNull()
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code must not be empty.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Cliente ausente', maxLength: 150, description: 'New display name. null is rejected' })
    @OptionalNotNull()
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name must not be empty.' })
    @MaxLength(150, { message: 'Name must not exceed 150 characters.' })
    name?: string;

    @ApiPropertyOptional({ example: true, description: 'Whether logging an incident with this reason requires a photo of evidence. null is rejected' })
    @OptionalNotNull()
    @IsBoolean({ message: 'Requires evidence must be true or false.' })
    requiresEvidence?: boolean;

    @ApiPropertyOptional({ example: false, description: 'false disables the reason for new incidents; incidents already logged with it are not affected. true enables it again. null is rejected' })
    @OptionalNotNull()
    @IsBoolean({ message: 'Active must be true or false.' })
    active?: boolean;
}
