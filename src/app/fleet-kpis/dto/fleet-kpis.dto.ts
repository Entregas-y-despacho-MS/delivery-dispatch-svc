import { ApiProperty } from '@nestjs/swagger';
import { DriverMetricsPeriod } from '../../driver-metrics/domain/metrics-period.js';
import { SlaMetricsDto, SlaReportRowDto } from '../../sla-report/dto/sla-report.dto.js';

export class FleetKpisDto {
    @ApiProperty({ enum: DriverMetricsPeriod, example: 'week', description: 'The period asked for' })
    period!: DriverMetricsPeriod;

    @ApiProperty({ type: String, format: 'date', example: '2026-11-02', description: 'First Bolivia day of the period, inclusive (YYYY-MM-DD)' })
    from!: string;

    @ApiProperty({ type: String, format: 'date', example: '2026-11-08', description: 'Last Bolivia day of the period (today), inclusive (YYYY-MM-DD)' })
    to!: string;

    @ApiProperty({ type: SlaMetricsDto, description: 'Figures of the whole fleet in the period (cards of the board): dispatches closed, on-time percentage and incidents, built from the real sums of the drivers' })
    totals!: SlaMetricsDto;

    @ApiProperty({ type: [SlaReportRowDto], description: 'One row per driver with closed dispatches in the period, ordered by name (the dispatches without driver, last, with `groupId` and `groupName` null). The ranking by on-time percentage or incidents is sorted by the client. Empty when nothing closed in the period' })
    drivers!: SlaReportRowDto[];

    @ApiProperty({ type: [SlaReportRowDto], description: 'One row per vehicle with closed dispatches in the period, `groupName` being its plate; ordered by plate (the dispatches without vehicle, last, with `groupId` and `groupName` null). Empty when nothing closed in the period' })
    vehicles!: SlaReportRowDto[];
}
