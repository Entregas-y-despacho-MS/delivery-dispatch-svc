import { ApiProperty } from '@nestjs/swagger';

export class CancelDispatchResultDto {
    @ApiProperty({ type: 'integer', example: 42, description: 'Id of the cancelled dispatch' })
    dispatchId!: number;

    @ApiProperty({ type: String, example: 'cancelled', description: 'Status of the dispatch after the cancellation; always `cancelled`' })
    status!: string;

    @ApiProperty({ type: String, example: 'assigned', description: 'Status the dispatch had before the cancellation. A delivery: `pending`, `address_review`, `in_planning`, `scheduled` or `assigned`. A pickup order: `pickup_scheduled` or `in_planning`' })
    previousStatus!: string;

    @ApiProperty({ type: String, format: 'date-time', example: '2026-10-19T15:00:00.000Z', description: 'Moment the dispatch was closed (the cancellation); it is the date the history filters by' })
    closedAt!: string;

    @ApiProperty({ type: String, example: 'COORD-CANCELLED', description: 'Code of the reason of the cancellation (`COORD-CANCELLED`). It is published to the ERP for a delivery; the cancellation of a pickup order is not published' })
    reasonCode!: string;

    @ApiProperty({
        type: 'integer', nullable: true, example: 17,
        description: 'Id of the route batch the dispatch belongs to (only a cancelled `assigned` dispatch stays linked, so the history shows its driver and vehicle); `null` when it had none or when it left the batch (`in_planning`, `scheduled`). Always `null` for a pickup order, which is not cancellable once assigned',
    })
    routeBatchId!: number | null;

    @ApiProperty({
        type: Boolean, example: false,
        description: 'Whether the cancellation closed the route batch because no dispatch of it was left in `assigned`, `out_for_delivery` or `in_transit`; also `true` when a batch in execution closes because the dispatch left it (`in_planning`, `scheduled`). `false` when the dispatch leaves a provisional batch and that batch, left empty, is cancelled instead of closed',
    })
    routeBatchClosed!: boolean;
}
