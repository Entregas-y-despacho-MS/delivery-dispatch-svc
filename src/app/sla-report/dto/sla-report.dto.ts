import { ApiProperty } from '@nestjs/swagger';
import { SlaGroupBy } from '../domain/sla-group-by.js';

export class SlaMetricsDto {
    @ApiProperty({ type: 'integer', minimum: 0, example: 42, description: 'Delivery dispatches closed inside the range (`delivered`, `not_delivered`, `returned` or `returned_to_warehouse`, by closing time in Bolivia days). Cancelled dispatches are not counted' })
    closedCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 38, description: 'Closed dispatches that ended `delivered`' })
    deliveredCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 35, description: 'Delivered dispatches closed inside the committed window (`scheduled_window_start` to `scheduled_window_end`, both included). A dispatch without a window is never on time' })
    onTimeCount!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 2, description: 'Delivered dispatches closed after the end of the committed window. `deliveredCount - onTimeCount - lateCount` are the ones closed before the window opened or without a window' })
    lateCount!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, maximum: 100, example: 92.1, description: 'Percentage of the delivered dispatches closed inside the committed window, with one decimal. 0 when nothing was delivered' })
    onTimePercentage!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, example: 18.5, description: 'Average delay, in minutes with one decimal, of the dispatches delivered after the end of the window (counted from that end). null when none was late' })
    averageDelayMinutes!: number | null;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 0, example: 143.2, description: 'Average cycle, in minutes with one decimal, from the last departure of the route (`out_for_delivery`) to the delivery, over the delivered dispatches with a recorded departure. null when there is none' })
    averageCycleMinutes!: number | null;

    @ApiProperty({ type: 'integer', minimum: 0, example: 5, description: 'Incidents (`dispatch_incidents`) of the closed dispatches, whatever their reason (company failures included)' })
    incidentCount!: number;
}

export class SlaReportRowDto extends SlaMetricsDto {
    @ApiProperty({ type: 'integer', nullable: true, minimum: 1, example: 3, description: 'ID of the zone, service level or driver (user) of the group. null for the dispatches that have none' })
    groupId!: number | null;

    @ApiProperty({ type: String, nullable: true, example: 'Zona Sur', description: 'Name of the zone, service level or driver of the group. null for the dispatches that have none: the screen labels it' })
    groupName!: string | null;
}

export class SlaReportDto {
    @ApiProperty({ type: String, format: 'date', example: '2026-10-01', description: 'First Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-31', description: 'Last Bolivia day of the range, inclusive (YYYY-MM-DD)' })
    to!: string;

    @ApiProperty({ enum: SlaGroupBy, example: 'zone', description: 'Grouping of `rows`' })
    groupBy!: SlaGroupBy;

    @ApiProperty({ type: SlaMetricsDto, description: 'The figures of all the rows together, computed from their real sums (not an average of the group averages). With `service_level` the levels that are no longer active are not in the rows, so they are not in the totals either' })
    totals!: SlaMetricsDto;

    @ApiProperty({ type: [SlaReportRowDto], description: 'One row per group that has closed dispatches in the range, ordered by name (the group without one, last). Empty when nothing closed in the range' })
    rows!: SlaReportRowDto[];
}
