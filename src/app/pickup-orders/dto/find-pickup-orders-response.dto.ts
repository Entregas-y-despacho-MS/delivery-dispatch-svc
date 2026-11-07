import { ApiProperty } from '@nestjs/swagger';
import { PaginationResponseDto } from '../../../shared/dto/index.js';
import { PickupOrderDto } from './pickup-order.dto.js';

export class FindPickupOrdersResponseDto extends PaginationResponseDto<PickupOrderDto> {
    @ApiProperty({ type: [PickupOrderDto], description: 'Pickup orders of the page, newest first' })
    declare data: PickupOrderDto[];
}
