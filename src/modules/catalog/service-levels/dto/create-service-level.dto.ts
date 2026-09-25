import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_PRIORITY_LEVEL, MAX_TARGET_TIME_MIN, MIN_TARGET_TIME_MIN } from './service-level-limits.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateServiceLevelDto {
    @ApiProperty({ example: 'Express 2 Horas', maxLength: 50 })
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Name is required.' })
    @MaxLength(50, { message: 'Name must not exceed 50 characters.' })
    name: string;

    @ApiPropertyOptional({ example: 'Entrega prioritaria en 2 horas', maxLength: 255 })
    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255, { message: 'Description must not exceed 255 characters.' })
    description?: string;

    @ApiProperty({ example: 120, minimum: MIN_TARGET_TIME_MIN, maximum: MAX_TARGET_TIME_MIN, description: 'Target delivery time (SLA) in minutes — an integer, at least 15' })
    @IsInt({ message: 'Target time must be an integer number of minutes.' })
    @Min(MIN_TARGET_TIME_MIN, { message: `Target time must be at least ${MIN_TARGET_TIME_MIN} minutes.` })
    @Max(MAX_TARGET_TIME_MIN, { message: `Target time must not exceed ${MAX_TARGET_TIME_MIN} minutes.` })
    targetTimeMin: number;

    @ApiProperty({ example: 1, minimum: 1, description: 'Priority hierarchy: 1 is the highest. Levels may share a value.' })
    @IsInt({ message: 'Priority level must be an integer.' })
    @Min(1, { message: 'Priority level must be at least 1.' })
    @Max(MAX_PRIORITY_LEVEL, { message: `Priority level must not exceed ${MAX_PRIORITY_LEVEL}.` })
    priorityLevel: number;
}
