import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../../shared/dto/index.js';
import { DeliveryZoneDto } from './delivery-zone.dto.js';

// Concrete subclass needed for Swagger — it cannot resolve generics at runtime.
export class FindAllDeliveryZonesResponseDto extends PaginationResponseDto<DeliveryZoneDto> {
    @ApiProperty({ type: [DeliveryZoneDto] })
    declare data: DeliveryZoneDto[];
}
