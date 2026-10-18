import { ApiProperty } from '@nestjs/swagger';
import type { DriverDispatchStatus } from './update-dispatch-status.dto.js';

export class DispatchStatusResponseDto {
    @ApiProperty({ example: 42, description: 'Dispatch identifier whose state was updated.' })
    dispatchId!: number;

    @ApiProperty({ enum: ['in_transit', 'delivered', 'not_delivered'], example: 'in_transit', description: 'Current dispatch status.' })
    status!: DriverDispatchStatus;

    @ApiProperty({ enum: ['out_for_delivery', 'in_transit'], example: 'out_for_delivery', description: 'Dispatch status before this transition.' })
    previousStatus!: string;

    @ApiProperty({ example: 2, description: 'Planning version. Status transitions do not increment it.' })
    version!: number;

    @ApiProperty({ format: 'date-time', description: 'Server timestamp at which the new status was persisted.' })
    updatedAt!: Date;
}
