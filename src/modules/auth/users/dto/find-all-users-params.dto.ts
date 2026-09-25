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
    @ApiPropertyOptional({ example: 2, description: 'Filtrar por ID de rol' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    roleId?: number;

    @ApiPropertyOptional({
        enum:        UserStatusEnum,
        description: 'Filtrar por estado: inactive (desactivado), locked (activo pero bloqueado temporalmente por intentos fallidos) o active (el resto). No se puede combinar con `active`.',
    })
    @IsOptional()
    @IsEnum(UserStatusEnum, { message: "The 'status' parameter must be one of: active, inactive, locked." })
    status?: UserStatusEnum;

    @ApiPropertyOptional({ example: true, description: 'Filtrar por usuarios activos/inactivos (solo el campo `active`; para incluir "bloqueado" usar `status`). No se puede combinar con `status`.' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ example: 'carlos', maxLength: 100, description: 'Busca (sin distinguir mayúsculas) dentro del nombre completo, el usuario o el correo. Los filtros se combinan con "y".' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: UserSortBy, default: UserSortBy.CREATED_AT, description: 'Campo de ordenamiento. Default: createdAt.' })
    @IsOptional()
    @IsEnum(UserSortBy, { message: "The 'sortBy' parameter must be one of: fullName, username, createdAt, lastLoginAt." })
    sortBy?: UserSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc', description: 'Sentido del ordenamiento. Default: desc.' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
    @IsIn(['asc', 'desc'], { message: "The 'sortOrder' parameter must be 'asc' or 'desc'." })
    sortOrder?: 'asc' | 'desc';
}
