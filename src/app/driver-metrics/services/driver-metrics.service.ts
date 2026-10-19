import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { METRICS_CACHE_TTL_SECONDS, metricsCacheKey } from '../domain/metrics-cache-key.js';
import { DriverMetricsPeriod, resolveMetricsRange } from '../domain/metrics-period.js';
import { DriverMetricsDto } from '../dto/driver-metrics.dto.js';
import { DriverMetricsRepository, type DriverMetricsRow } from '../repositories/driver-metrics.repository.js';

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function isMetrics(value: unknown): value is DriverMetricsDto {
    const metrics = value as Partial<DriverMetricsDto> | null;
    return typeof metrics === 'object' && metrics !== null
        && typeof metrics.deliveredCount === 'number' && typeof metrics.assignedCount === 'number'
        && typeof metrics.onTimePercentage === 'number' && typeof metrics.ratingsCount === 'number';
}

@Injectable()
export class DriverMetricsService {
    private readonly logger = new Logger(DriverMetricsService.name);

    constructor(
        private readonly repository: DriverMetricsRepository,
        private readonly cache: CacheService,
    ) {}

    /**
     * The metrics of the driver, served from Redis when there. The cache is only an accelerator: if Redis
     * does not answer, or holds something unreadable, the request is answered from PostgreSQL with a warning.
     */
    async get(driverId: number, period: DriverMetricsPeriod): Promise<DriverMetricsDto> {
        const key = metricsCacheKey(driverId, period);
        const cached = await this.read(key);
        if (cached) return cached;

        const metrics = await this.compute(driverId, period);
        await this.write(key, metrics);
        return metrics;
    }

    /** Computes the metrics of the driver straight from PostgreSQL. */
    async compute(driverId: number, period: DriverMetricsPeriod, now: Date = new Date()): Promise<DriverMetricsDto> {
        const range = resolveMetricsRange(period, now);
        return this.toDto(period, range, await this.repository.aggregate(driverId, range));
    }

    private async read(key: string): Promise<DriverMetricsDto | null> {
        try {
            const raw = await this.cache.get(key);
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            if (isMetrics(parsed)) return parsed;
            this.logger.warn(`The cached metrics under ${key} are not valid; computing from PostgreSQL.`);
        } catch (error) {
            this.logger.warn(`Could not read the metrics cache (${key}); computing from PostgreSQL. ${error instanceof Error ? error.message : ''}`.trim());
        }
        return null;
    }

    private async write(key: string, metrics: DriverMetricsDto): Promise<void> {
        try {
            await this.cache.setWithTtl(key, JSON.stringify(metrics), METRICS_CACHE_TTL_SECONDS);
        } catch (error) {
            this.logger.warn(`Could not store the metrics in the cache (${key}). ${error instanceof Error ? error.message : ''}`.trim());
        }
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
