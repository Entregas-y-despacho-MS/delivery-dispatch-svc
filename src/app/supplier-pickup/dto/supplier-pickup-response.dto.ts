import { ApiProperty } from '@nestjs/swagger';

export class SupplierPickupResponseDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Dispatch identifier.' })
    dispatchId!: number;

    @ApiProperty({ example: 'picked_up_in_transit', description: 'Dispatch status after the collection was registered.' })
    status!: string;

    @ApiProperty({ format: 'date-time', description: 'Server timestamp at which custody of the goods was recorded.' })
    custodyReceivedAt!: Date;

    @ApiProperty({ example: false, description: 'Whether a quantity difference was found and an incident was raised.' })
    hasDiscrepancy!: boolean;
}

export class ReturnPickupResponseDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Dispatch identifier.' })
    dispatchId!: number;

    @ApiProperty({ example: 'picked_up_in_transit', description: 'Dispatch status after the pickup was registered.' })
    status!: string;

    @ApiProperty({ format: 'date-time', description: 'Time at which the driver took custody of the returned goods (acknowledgement of the pickup).' })
    custodyReceivedAt!: Date;

    @ApiProperty({ example: true, description: 'Whether the 3 checklist points were all checked.' })
    checklistComplete!: boolean;
}

export class ArrivedAtWarehouseResponseDto {
    @ApiProperty({ example: 42, description: 'Dispatch identifier.' })
    dispatchId!: number;

    @ApiProperty({ format: 'date-time', description: 'Server timestamp at which the arrival at the destination warehouse was recorded.' })
    arrivedAtWarehouseAt!: Date;
}
