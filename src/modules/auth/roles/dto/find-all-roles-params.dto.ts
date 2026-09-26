import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { RoleEnum } from '../../../../shared/enums/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum RoleSortBy {
    ID         = 'id',
    NAME       = 'name',
    CREATED_AT = 'createdAt',
}

export class FindAllRolesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ maxLength: 100, description: 'E.g. admin. Text contained in the role name (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: RoleEnum, description: 'Only the role with exactly this name — the quickest way to find the `id` of, say, `driver`. Combine with the other filters with "and"' })
    @IsOptional()
    @IsEnum(RoleEnum, { message: "The 'name' parameter must be one of: root, admin, coordinator, supervisor, driver." })
    name?: RoleEnum;

    @ApiPropertyOptional({ description: 'true = only the roles YOU may give to a user: everything except `root` unless you are root (an admin cannot create root users, 403 ROOT_ACCOUNT_PROTECTED). Use it to fill the role selector of the user form. Omit (or send it empty) for all roles' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'assignable'))
    @IsBoolean()
    assignable?: boolean;

    @ApiPropertyOptional({ enum: RoleSortBy, default: RoleSortBy.ID, description: 'Field to sort by. Default: id (the order of the catalog). Ties are broken by id' })
    @IsOptional()
    @IsEnum(RoleSortBy, { message: "The 'sortBy' parameter must be one of: id, name, createdAt." })
    sortBy?: RoleSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction. Default: asc' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
