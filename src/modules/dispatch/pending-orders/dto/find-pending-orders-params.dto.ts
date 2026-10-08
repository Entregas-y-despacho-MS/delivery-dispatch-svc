import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PaginationParamsDto } from '../../../../shared/dto/index.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';

export enum PendingOrderShift {
    MORNING   = 'morning',
    AFTERNOON = 'afternoon',
}

export enum PendingOrderPriority {
    URGENT = 'urgent',
    NORMAL = 'normal',
}

export enum PendingOrderSortBy {
    ORDER_NUMBER = 'orderNumber',
    RECIPIENT    = 'recipient',
    ZONE         = 'zone',
    WINDOW       = 'window',
    WEIGHT       = 'weight',
    PRIORITY     = 'priority',
}

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

// The filter names follow the ST-48.2 spec literally (`delivery_zone_id`, `order`), so the web client
// built against the ticket works as written.
export class FindPendingOrdersParamsDto extends PaginationParamsDto {
    @ApiPropertyOptional({ type: 'integer', description: 'Only orders of this delivery zone' })
    @IsOptional()
    @Type(() => Number)
    @IsInt({ message: "The 'delivery_zone_id' parameter must be an integer." })
    @Min(1, { message: "The 'delivery_zone_id' parameter must be >= 1." })
    @Max(INT4_MAX, { message: `The 'delivery_zone_id' parameter must be <= ${INT4_MAX}.` })
    delivery_zone_id?: number;

    @ApiPropertyOptional({ enum: PendingOrderShift, description: 'Shift of the agreed delivery window, in Bolivia time: morning = starts before 12:00, afternoon = starts at 12:00 or later. Orders without a window match neither' })
    @IsOptional()
    @Transform(lower)
    @IsIn(Object.values(PendingOrderShift), { message: "The 'shift' parameter must be one of: morning, afternoon." })
    shift?: PendingOrderShift;

    @ApiPropertyOptional({ enum: PendingOrderPriority, description: 'Only urgent or only normal orders' })
    @IsOptional()
    @Transform(lower)
    @IsIn(Object.values(PendingOrderPriority), { message: "The 'priority' parameter must be one of: urgent, normal." })
    priority?: PendingOrderPriority;

    @ApiPropertyOptional({ maxLength: 100, description: 'Text contained in the recipient name or in the tracking code (case-insensitive; % and _ are matched literally)' })
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    @IsString()
    @MaxLength(100, { message: "The 'search' parameter must not exceed 100 characters." })
    search?: string;

    @ApiPropertyOptional({ enum: PendingOrderSortBy, description: 'Field to sort by. Default: urgent orders first, then the earliest SLA deadline' })
    @IsOptional()
    @IsIn(Object.values(PendingOrderSortBy), { message: "The 'sortBy' parameter must be one of: orderNumber, recipient, zone, window, weight, priority." })
    sortBy?: PendingOrderSortBy;

    @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction when `sortBy` is given. Default: asc (for `priority`, asc puts urgent first)' })
    @IsOptional()
    @Transform(lower)
    @IsIn(['asc', 'desc'], { message: "The 'order' parameter must be 'asc' or 'desc'." })
    order?: 'asc' | 'desc';
}
