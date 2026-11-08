import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { DriverMetricsPeriod } from '../../driver-metrics/domain/metrics-period.js';

export class FleetKpisParamsDto {
    @ApiProperty({ enum: DriverMetricsPeriod, description: 'Period to summarize, counted in Bolivia days: `today`, `week` (Monday to today) or `month` (the 1st to today)' })
    @IsEnum(DriverMetricsPeriod, { message: "The 'period' parameter must be one of: today, week, month." })
    period!: DriverMetricsPeriod;
}
