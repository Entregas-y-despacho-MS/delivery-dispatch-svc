import { ApiProperty } from '@nestjs/swagger';
import { DriverMetricsPeriod } from '../domain/metrics-period.js';

export class DriverMetricsDto {
    @ApiProperty({ enum: DriverMetricsPeriod, example: 'today', description: 'Period the figures cover, counted in Bolivia days: `today`, `week` (Monday to today) or `month` (the 1st to today)' })
    period!: DriverMetricsPeriod;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-19', description: 'First Bolivia day of the period, inclusive (YYYY-MM-DD)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-10-19', description: 'Last Bolivia day of the period, inclusive (YYYY-MM-DD)' })
    to!: string;

    @ApiProperty({ type: 'integer', minimum: 0, example: 12, description: 'Dispatches of the driver delivered (`delivered`) with a closing time inside the period' })
    deliveredCount!: number;

    @ApiProperty({ type: 'number', format: 'double', minimum: 0, maximum: 100, example: 91.7, description: 'Percentage of those deliveries closed inside the committed window (`scheduled_window_start/end`), with one decimal. 0 when nothing was delivered or the dispatch has no window' })
    onTimePercentage!: number;

    @ApiProperty({ type: 'integer', minimum: 0, example: 14, description: 'Dispatches assigned to the driver on routes whose day falls inside the period (cancelled routes excluded)' })
    assignedCount!: number;

    @ApiProperty({ type: 'number', format: 'double', nullable: true, minimum: 1, maximum: 5, example: 4.6, description: 'Average score (1 to 5, one decimal) of the ratings of the deliveries of the period. null when there are none: the app then shows the neutral initial rating (5.0)' })
    rating!: number | null;

    @ApiProperty({ type: 'integer', minimum: 0, example: 8, description: 'Number of ratings behind `rating`. 0 when there are none' })
    ratingsCount!: number;
}
