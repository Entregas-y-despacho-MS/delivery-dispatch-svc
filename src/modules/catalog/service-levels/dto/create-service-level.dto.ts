import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PRIORITY_LEVEL, MAX_TARGET_TIME_MIN, MIN_TARGET_TIME_MIN } from './service-level-limits.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateServiceLevelDto {
    @ApiProperty({ example: 'Express 2 Horas', maxLength: 50, description: 'Unique name (leading/trailing spaces are trimmed; uniqueness is case-sensitive). Required' })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(50, { message: 'Name must not exceed 50 characters.' })
    name: string;

    @ApiPropertyOptional({ example: 'Entrega prioritaria en 2 horas', maxLength: 255, description: 'Optional free-text description. Empty or blank text is stored as null' })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255, { message: 'Description must not exceed 255 characters.' })
    description?: string;

    @ApiProperty({ type: 'integer', example: 120, minimum: MIN_TARGET_TIME_MIN, maximum: MAX_TARGET_TIME_MIN, description: `Target delivery time (SLA) in minutes. An integer from ${MIN_TARGET_TIME_MIN} (a shorter time is not a realistic commitment, RF-A31) to ${MAX_TARGET_TIME_MIN} (30 days)` })
    @IsInt({ message: 'Target time must be an integer number of minutes.' })
    @Min(MIN_TARGET_TIME_MIN, { message: `Target time must be at least ${MIN_TARGET_TIME_MIN} minutes.` })
    @Max(MAX_TARGET_TIME_MIN, { message: `Target time must not exceed ${MAX_TARGET_TIME_MIN} minutes.` })
    targetTimeMin: number;

    @ApiProperty({ type: 'integer', example: 1, minimum: 1, maximum: MAX_PRIORITY_LEVEL, description: 'Priority hierarchy: 1 is the highest. Levels may share a value; the list breaks ties by target time' })
    @IsInt({ message: 'Priority level must be an integer.' })
    @Min(1, { message: 'Priority level must be at least 1.' })
    @Max(MAX_PRIORITY_LEVEL, { message: `Priority level must not exceed ${MAX_PRIORITY_LEVEL}.` })
    priorityLevel: number;
}
