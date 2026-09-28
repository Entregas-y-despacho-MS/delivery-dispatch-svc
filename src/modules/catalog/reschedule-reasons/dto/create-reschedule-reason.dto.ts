import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// The code is looked up by exact value (unique index), so it is normalized the same way
// incident_reasons' code is (trim + uppercase) before validation and before it reaches the database.
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class CreateRescheduleReasonDto {
    @ApiProperty({ example: 'RES-CLI-EXP', maxLength: 30, description: 'Unique reference code. Trimmed and uppercased before validation; must not belong to another reason' })
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code: string;

    @ApiProperty({ example: 'Solicitud expresa del cliente', maxLength: 150, description: 'Display name. Trimmed; must not belong to another reason' })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(150, { message: 'Name must not exceed 150 characters.' })
    name: string;

    @ApiPropertyOptional({ example: 'El cliente pidió mover la entrega a la tarde', maxLength: 255, description: 'Optional free-text detail' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255, { message: 'Description must not exceed 255 characters.' })
    description?: string;

    @ApiProperty({ enum: RescheduleReasonCategoryEnum, example: RescheduleReasonCategoryEnum.CLIENT, description: 'Who/what the delay is attributed to. Required — the coordinator must classify it explicitly' })
    @IsEnum(RescheduleReasonCategoryEnum, { message: 'Category must be one of: client, operations, force_majeure.' })
    category: RescheduleReasonCategoryEnum;
}
