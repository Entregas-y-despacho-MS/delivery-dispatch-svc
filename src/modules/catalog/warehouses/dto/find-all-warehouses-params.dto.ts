import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum WarehouseSortBy {
    CODE       = 'code',
    NAME       = 'name',
    CREATED_AT = 'createdAt',
}

export class FindAllWarehousesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. LPZ. Text contained in the code or the name (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ description: 'true = only enabled warehouses, false = only disabled ones. Omit (or send it empty) for all. Any other value is rejected with 400' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ enum: WarehouseSortBy, default: WarehouseSortBy.NAME, description: 'Field to sort by. Default: name' })
    @IsOptional()
    @IsIn(Object.values(WarehouseSortBy), { message: "The 'sortBy' parameter must be one of: code, name, createdAt." })
    sortBy?: WarehouseSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction. Default: asc' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
