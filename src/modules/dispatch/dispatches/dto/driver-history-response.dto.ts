import { ApiProperty } from '@nestjs/swagger';

export class DriverHistoryItemDto {
    @ApiProperty({ type: String, nullable: true, description: 'Dispatch tracking code.' }) trackingCode: string | null;
    @ApiProperty({ type: String, nullable: true, description: 'Customer or destination contact name.' }) customerName: string | null;
    @ApiProperty({ type: String, nullable: true, description: 'Name of the person who received the dispatch, when captured.' }) receiverName: string | null;
    @ApiProperty({ enum: ['delivered', 'returned'], description: 'Final dispatch status.' }) status: 'delivered' | 'returned';
    @ApiProperty({ type: String, format: 'date-time', description: 'Timestamp when the dispatch was closed.' }) closedAt: Date;
    @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Most recent evidence identifier, when available.' }) evidenceId: string | null;
}

export class DriverHistoryResponseDto {
    @ApiProperty({ type: [DriverHistoryItemDto], description: 'History rows on the requested page; empty when no dispatches match.' }) data: DriverHistoryItemDto[];
    @ApiProperty({ description: 'Number of matching dispatches across all pages.' }) total: number;
    @ApiProperty({ description: 'One-based current page.' }) page: number;
    @ApiProperty({ description: 'Requested page size.' }) limit: number;
}
