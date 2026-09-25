import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';
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
    vehicleStatusId?: number;
}
