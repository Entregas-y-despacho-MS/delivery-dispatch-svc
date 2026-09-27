import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';

// The code is looked up by exact value (unique index), so it is normalized the same way a plate is
// (trim + uppercase) before validation and before it ever reaches the database.
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const trim          = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateIncidentReasonDto {
    @ApiProperty({ example: 'INC-CLI-AUS', maxLength: 30, description: 'Unique reference code. Trimmed and uppercased before validation; must not belong to another reason' })
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
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
}
