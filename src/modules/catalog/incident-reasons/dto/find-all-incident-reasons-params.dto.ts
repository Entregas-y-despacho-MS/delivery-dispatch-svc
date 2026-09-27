import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum IncidentReasonSortBy {
    NAME       = 'name',
    CODE       = 'code',
    CREATED_AT = 'createdAt',
}

export class FindAllIncidentReasonsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. absent. Text contained in the name or the code (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ description: 'true = only enabled reasons, false = only disabled ones. Omit (or send it empty) for all. Any other value is rejected with 400' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ description: 'true = only reasons that require a photo, false = only the ones that do not. Omit (or send it empty) for all' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'requiresEvidence'))
    @IsBoolean()
    requiresEvidence?: boolean;

    @ApiPropertyOptional({ enum: IncidentReasonSortBy, default: IncidentReasonSortBy.NAME, description: 'Field to sort by. Default: name' })
    @IsOptional()
    @IsIn(Object.values(IncidentReasonSortBy), { message: "The 'sortBy' parameter must be one of: name, code, createdAt." })
    sortBy?: IncidentReasonSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction. Default: asc' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
