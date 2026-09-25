import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { MAX_PRIORITY_LEVEL, MAX_TARGET_TIME_MIN, MIN_TARGET_TIME_MIN } from './service-level-limits.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateServiceLevelDto {
    @ApiPropertyOptional({ example: 'Express 2 Horas', maxLength: 50 })
    @OptionalNotNull()
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name must not be empty.' })
    @MaxLength(50, { message: 'Name must not exceed 50 characters.' })
    name?: string;

    // The column is nullable: null (or an empty text) clears the description.
    @ApiPropertyOptional({ example: 'Entrega prioritaria en 2 horas', maxLength: 255, nullable: true })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255, { message: 'Description must not exceed 255 characters.' })
    description?: string | null;

    @ApiPropertyOptional({ example: 120, minimum: MIN_TARGET_TIME_MIN, maximum: MAX_TARGET_TIME_MIN })
    @OptionalNotNull()
    @IsInt({ message: 'Target time must be an integer number of minutes.' })
    @Min(MIN_TARGET_TIME_MIN, { message: `Target time must be at least ${MIN_TARGET_TIME_MIN} minutes.` })
    @Max(MAX_TARGET_TIME_MIN, { message: `Target time must not exceed ${MAX_TARGET_TIME_MIN} minutes.` })
    targetTimeMin?: number;

    @ApiPropertyOptional({ example: 1, minimum: 1 })
    @OptionalNotNull()
    @IsInt({ message: 'Priority level must be an integer.' })
    @Min(1, { message: 'Priority level must be at least 1.' })
    @Max(MAX_PRIORITY_LEVEL, { message: `Priority level must not exceed ${MAX_PRIORITY_LEVEL}.` })
    priorityLevel?: number;

    @ApiPropertyOptional({ example: false, description: 'false disables the level for new orders; dispatches that already use it are not affected.' })
    @OptionalNotNull()
    @IsBoolean({ message: 'Active must be true or false.' })
    active?: boolean;
}
