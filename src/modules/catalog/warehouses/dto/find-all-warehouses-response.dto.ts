import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { WarehouseDto } from './warehouse.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllWarehousesResponseDto extends PaginationResponseDto<WarehouseDto> {
    @ApiProperty({ type: [WarehouseDto] })
    declare data: WarehouseDto[];
}
