import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';

export class FindAllVehiclesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ example: 'ABC', description: 'Filter by plate, model or type' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ example: 1, description: 'Filter by operational status ID' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    vehicleStatusId?: number;
}
