import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export class FindAllServiceLevelsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ example: 'express', maxLength: 100, description: 'Filter by name or description (case-insensitive, contains)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ example: true, description: 'true = only enabled levels, false = only disabled ones. Omit for all.' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;
}
