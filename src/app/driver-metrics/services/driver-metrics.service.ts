import { Injectable } from '@nestjs/common';
import { DriverMetricsPeriod, resolveMetricsRange } from '../domain/metrics-period.js';
import { DriverMetricsDto } from '../dto/driver-metrics.dto.js';
import { DriverMetricsRepository, type DriverMetricsRow } from '../repositories/driver-metrics.repository.js';

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

@Injectable()
export class DriverMetricsService {
    constructor(private readonly repository: DriverMetricsRepository) {}

    /** Computes the metrics of the driver straight from PostgreSQL. */
    async compute(driverId: number, period: DriverMetricsPeriod, now: Date = new Date()): Promise<DriverMetricsDto> {
        const range = resolveMetricsRange(period, now);
        return this.toDto(period, range, await this.repository.aggregate(driverId, range));
    }

    private toDto(period: DriverMetricsPeriod, range: { from: string; to: string }, row: DriverMetricsRow): DriverMetricsDto {
        return {
            period,
            from: range.from,
            to: range.to,
            deliveredCount: row.deliveredCount,
            onTimePercentage: row.deliveredCount === 0 ? 0 : round1((row.onTimeCount / row.deliveredCount) * 100),
            assignedCount: row.assignedCount,
            // No ratings: null, so the app shows the neutral initial rating instead of a made-up average.
            rating: row.ratingsCount === 0 || row.ratingAverage === null ? null : round1(row.ratingAverage),
            ratingsCount: row.ratingsCount,
        };
    }
}
