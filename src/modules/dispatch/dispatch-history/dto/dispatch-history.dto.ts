import { ApiProperty } from '@nestjs/swagger';
import { TERMINAL_DISPATCH_STATUSES } from '../../dispatches/utils/terminal-statuses.js';

export class DispatchHistoryItemDto {
    @ApiProperty({ type: 'integer', example: 12, description: 'Dispatch ID; the row links to the unified 360° view (`GET /dispatches/:id/detail`)' })
    id!: number;

    @ApiProperty({ type: String, nullable: true, example: 'DSP-2026-00012', description: 'Tracking code (código de traslado / de guía). null if the dispatch has none' })
    trackingCode!: string | null;

    @ApiProperty({ type: String, nullable: true, example: 'María Pérez', description: 'Contact person at the destination (the customer for a delivery). null if the origin did not send one' })
    recipient!: string | null;

    @ApiProperty({ type: 'integer', nullable: true, example: 7, description: 'ID of the driver of the route. null when the dispatch has no route' })
    driverId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Juan Quispe', description: 'Full name of the driver of the route. null when the dispatch has no route or the route has no driver' })
    driverName!: string | null;

    @ApiProperty({ type: String, nullable: true, example: '1234ABC', description: 'Plate of the vehicle of the route. null when the dispatch has no route or the route has no vehicle' })
    plate!: string | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the route left with this dispatch («Iniciar ruta», `out_for_delivery`). null when no departure was recorded (for example, a dispatch cancelled before leaving)' })
    departedAt!: Date | null;

    @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When the dispatch was delivered. null unless the final status is `delivered`' })
    deliveredAt!: Date | null;

    @ApiProperty({ enum: TERMINAL_DISPATCH_STATUSES, example: 'delivered', description: 'Final status of the dispatch' })
    status!: string;

    @ApiProperty({ type: String, format: 'date-time', description: 'When the dispatch reached its final status (the time of the event, not of its reception). The date range filters on it' })
    closedAt!: Date;
}

// The history answers { data, total, page, limit } as the ticket defines it, not the { data, meta } of the other lists.
export class FindDispatchHistoryResponseDto {
    @ApiProperty({ type: [DispatchHistoryItemDto], description: 'Dispatches on the current page' })
    data!: DispatchHistoryItemDto[];

    @ApiProperty({ type: 'integer', example: 42, description: 'Total number of dispatches matching the filters' })
    total!: number;

    @ApiProperty({ type: 'integer', example: 1, description: 'Current page number' })
    page!: number;

    @ApiProperty({ type: 'integer', example: 10, description: 'Items per page' })
    limit!: number;
}
