import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';

export class FindAllDeliveryZonesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ example: 'Sur', description: 'Filtrar por nombre o código' })
    @IsOptional()
    @IsString()
    search?: string;
}
