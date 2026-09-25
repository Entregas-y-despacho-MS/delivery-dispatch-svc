import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';

export class FindAllDeliveryZonesParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ description: 'E.g. Sur. Text contained in the zone code or name (case-insensitive)' })
    @IsOptional()
    @IsString()
    search?: string;
}
