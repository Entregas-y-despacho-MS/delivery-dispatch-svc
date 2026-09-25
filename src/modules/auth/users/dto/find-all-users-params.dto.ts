import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { UserStatusEnum } from '../../../../shared/enums/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export enum UserSortBy {
    FULL_NAME     = 'fullName',
    USERNAME      = 'username',
    CREATED_AT    = 'createdAt',
    LAST_LOGIN_AT = 'lastLoginAt',
}

export class FindAllUsersParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ type: 'integer', example: 2, description: 'Only users with this role. Use an ID from GET /roles' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    roleId?: number;

    @ApiPropertyOptional({
        enum:        UserStatusEnum,
        description: 'Only users in this status: inactive (deactivated by an admin), locked (active but temporarily locked after failed logins) or active (everything else). Cannot be combined with `active` (400 CONFLICTING_USER_FILTERS).',
    })
    @IsOptional()
    @IsEnum(UserStatusEnum, { message: "The 'status' parameter must be one of: active, inactive, locked." })
    status?: UserStatusEnum;

    @ApiPropertyOptional({ example: true, description: 'true = only active accounts, false = only deactivated ones (it looks at the `active` flag only; to tell locked users apart use `status`). Omit or send it empty for all. Cannot be combined with `status`.' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ example: 'carlos', maxLength: 100, description: 'Text contained in the full name, username or email (case-insensitive). Combined with the other filters using "and".' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: UserSortBy, default: UserSortBy.CREATED_AT, description: 'Field to sort by. Default: createdAt.' })
    @IsOptional()
    @IsEnum(UserSortBy, { message: "The 'sortBy' parameter must be one of: fullName, username, createdAt, lastLoginAt." })
    sortBy?: UserSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc', description: 'Sort direction. Default: desc (newest / last first).' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
