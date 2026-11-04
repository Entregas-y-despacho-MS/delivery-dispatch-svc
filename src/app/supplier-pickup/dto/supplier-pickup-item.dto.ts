import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min, MaxLength } from 'class-validator';

export class SupplierPickupItemDto {
    @ApiProperty({ example: 'SKU-1', description: 'Code of a product expected in this pickup (dispatch_pickup_items.item_code).' })
    @IsString()
    @MaxLength(100)
    itemCode!: string;

    @ApiProperty({ minimum: 0, example: 2, description: 'Quantity actually received for this item.' })
    @IsNumber({ allowNaN: false, allowInfinity: false })
    @Min(0)
    receivedQuantity!: number;
}
