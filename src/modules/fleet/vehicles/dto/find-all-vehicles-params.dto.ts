import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString, Max } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';

export class FindAllVehiclesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ description: 'E.g. ABC. Text contained in the plate, model or type (case-insensitive)' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ type: 'integer', description: 'Only vehicles in this operational status: 1 = active, 2 = maintenance, 3 = out_of_service' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    @Max(INT4_MAX)
    vehicleStatusId?: number;
}
