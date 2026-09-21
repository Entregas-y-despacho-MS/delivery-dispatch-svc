import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsPositive } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { transformToBoolean } from '../../../../shared/utils/transformers.util.js';

export class FindAllUsersParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ example: 2, description: 'Filtrar por ID de rol' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    roleId?: number;

    @ApiPropertyOptional({ example: true, description: 'Filtrar por usuarios activos/inactivos' })
    @IsOptional()
    @Transform(({ value }) => transformToBoolean(value, 'active'))
    @IsBoolean()
    active?: boolean;
}
