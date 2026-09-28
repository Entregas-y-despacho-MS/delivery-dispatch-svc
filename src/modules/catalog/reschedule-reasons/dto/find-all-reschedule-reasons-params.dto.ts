import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { RescheduleReasonCategoryEnum } from '../../../../shared/enums/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum RescheduleReasonSortBy {
    CODE       = 'code',
    NAME       = 'name',
    CATEGORY   = 'category',
    CREATED_AT = 'createdAt',
}

export class FindAllRescheduleReasonsParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. client. Text contained in the code, the name or the description (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: RescheduleReasonCategoryEnum, description: 'Only reasons in this category. Omit for all' })
    @IsOptional()
    @IsEnum(RescheduleReasonCategoryEnum, { message: "The 'category' parameter must be one of: client, operations, force_majeure." })
    category?: RescheduleReasonCategoryEnum;

    @ApiPropertyOptional({ description: 'true = only enabled reasons, false = only disabled ones. Omit (or send it empty) for all. Any other value is rejected with 400' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ enum: RescheduleReasonSortBy, default: RescheduleReasonSortBy.NAME, description: 'Field to sort by. Default: name' })
    @IsOptional()
    @IsIn(Object.values(RescheduleReasonSortBy), { message: "The 'sortBy' parameter must be one of: code, name, category, createdAt." })
    sortBy?: RescheduleReasonSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction. Default: asc' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
