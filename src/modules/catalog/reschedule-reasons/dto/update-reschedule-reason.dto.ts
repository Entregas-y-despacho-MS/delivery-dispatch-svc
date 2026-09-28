import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalizeCode = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class UpdateRescheduleReasonDto {
    @ApiPropertyOptional({ example: 'RES-CLI-EXP', maxLength: 30, description: 'New reference code. Trimmed and uppercased before validation; must not belong to another reason. null is rejected' })
    @OptionalNotNull()
    @Transform(normalizeCode)
    @IsString()
    @IsNotEmpty({ message: 'Code must not be empty.' })
    @MaxLength(30, { message: 'Code must not exceed 30 characters.' })
    code?: string;

    @ApiPropertyOptional({ example: 'Solicitud expresa del cliente', maxLength: 150, description: 'New display name. Must not belong to another reason. null is rejected' })
    @OptionalNotNull()
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name must not be empty.' })
    @MaxLength(150, { message: 'Name must not exceed 150 characters.' })
    name?: string;

    // Nullable column: null (or an empty text) clears it, same as service-levels' description.
    @ApiPropertyOptional({ type: String, example: 'El cliente pidió mover la entrega a la tarde', maxLength: 255, nullable: true, description: 'New description. null or empty text clears it' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255, { message: 'Description must not exceed 255 characters.' })
    description?: string | null;

    @ApiPropertyOptional({ enum: RescheduleReasonCategoryEnum, example: RescheduleReasonCategoryEnum.OPERATIONS, description: 'New category. null is rejected' })
    @OptionalNotNull()
    @IsEnum(RescheduleReasonCategoryEnum, { message: 'Category must be one of: client, operations, force_majeure.' })
    category?: RescheduleReasonCategoryEnum;

    @ApiPropertyOptional({ example: false, description: 'false disables the reason for new reschedules/reassignments; ones already logged with it are not affected. true enables it again. null is rejected' })
    @OptionalNotNull()
    @IsBoolean({ message: 'Active must be true or false.' })
    active?: boolean;
}
