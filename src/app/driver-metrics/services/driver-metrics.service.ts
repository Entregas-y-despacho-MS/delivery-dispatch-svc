import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { METRICS_CACHE_TTL_SECONDS, METRICS_EPOCH_TTL_SECONDS, allMetricsCacheKeys, metricsCacheKey, metricsEpochKey } from '../domain/metrics-cache-key.js';
import { DriverMetricsPeriod, resolveMetricsRange, type MetricsDateRange } from '../domain/metrics-period.js';
import { DriverMetricsDto } from '../dto/driver-metrics.dto.js';
import { DriverMetricsRepository, type DriverMetricsRow } from '../repositories/driver-metrics.repository.js';

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True only for an answer of exactly this period AND these days. The days matter: the key does not carry the
 * date, so an entry stored yesterday (or last week or month) would otherwise be served after midnight with
 * the old `from`/`to` until it expires.
 */
function isMetricsOf(value: unknown, period: DriverMetricsPeriod, range: MetricsDateRange): value is DriverMetricsDto {
    if (typeof value !== 'object' || value === null) return false;
    const metrics = value as Record<string, unknown>;
    return metrics.period === period && metrics.from === range.from && metrics.to === range.to
        && isNonNegativeInteger(metrics.deliveredCount) && isNonNegativeInteger(metrics.assignedCount) && isNonNegativeInteger(metrics.ratingsCount)
        && typeof metrics.onTimePercentage === 'number' && metrics.onTimePercentage >= 0 && metrics.onTimePercentage <= 100
        && (metrics.rating === null || (typeof metrics.rating === 'number' && metrics.rating >= 1 && metrics.rating <= 5))
        && (metrics.rating === null) === (metrics.ratingsCount === 0);
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
     * does not answer, or holds something unreadable or from another day, the request is answered from
     * PostgreSQL with a warning.
     */
    async get(driverId: number, period: DriverMetricsPeriod, now: Date = new Date()): Promise<DriverMetricsDto> {
        const range = resolveMetricsRange(period, now);
        const key = metricsCacheKey(driverId, period);
        const cached = await this.read(key, period, range);
        if (cached) return cached;

        // Taken BEFORE computing: if it moves, a delivery was confirmed while this answer was being built.
        const epoch = await this.readEpochOrUnknown(driverId);
        const metrics = this.toDto(period, range, await this.repository.aggregate(driverId, range));
        await this.write(driverId, key, metrics, epoch);
        return metrics;
    }

    /**
     * Drops the three cached periods of a driver. The epoch moves first, so an answer that is being computed right
     * now is not stored afterwards. Each key is attempted on its own, so one failure does not leave the others
     * stale; a cache that does not answer only warns (the entries expire by themselves within 5 minutes).
     */
    async invalidate(driverId: number): Promise<void> {
        try {
            await this.cache.increment(metricsEpochKey(driverId), METRICS_EPOCH_TTL_SECONDS);
        } catch (error) {
            this.logger.warn(`Could not move the metrics epoch of driver ${driverId}. ${error instanceof Error ? error.message : ''}`.trim());
        }
        for (const key of allMetricsCacheKeys(driverId)) {
            try {
                await this.cache.delete(key);
            } catch (error) {
                this.logger.warn(`Could not invalidate the metrics cache (${key}); it expires within ${METRICS_CACHE_TTL_SECONDS} seconds. ${error instanceof Error ? error.message : ''}`.trim());
            }
        }
    }

    /** Computes the metrics of the driver straight from PostgreSQL. */
    async compute(driverId: number, period: DriverMetricsPeriod, now: Date = new Date()): Promise<DriverMetricsDto> {
        const range = resolveMetricsRange(period, now);
        return this.toDto(period, range, await this.repository.aggregate(driverId, range));
    }

    private async read(key: string, period: DriverMetricsPeriod, range: MetricsDateRange): Promise<DriverMetricsDto | null> {
        try {
            const raw = await this.cache.get(key);
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            if (isMetricsOf(parsed, period, range)) return parsed;
            // Not an error when it is yesterday's answer; either way it is recomputed and overwritten.
            this.logger.warn(`The cached metrics under ${key} are not valid or are from another day; computing from PostgreSQL.`);
        } catch (error) {
            this.logger.warn(`Could not read the metrics cache (${key}); computing from PostgreSQL. ${error instanceof Error ? error.message : ''}`.trim());
        }
        return null;
    }

    /** `undefined` when the cache does not answer: then the result is simply not stored. */
    private async readEpochOrUnknown(driverId: number): Promise<string | null | undefined> {
        try {
            return await this.cache.get(metricsEpochKey(driverId));
        } catch {
            return undefined;
        }
    }

    /**
     * Stores the answer unless an invalidation happened while it was computed. Check, write, check again: if the
     * epoch moved between the write and the second check, the entry just stored is removed, so no interleaving of
     * a confirmation and a request can leave an answer older than the confirmation in the cache.
     */
    private async write(driverId: number, key: string, metrics: DriverMetricsDto, epochBefore: string | null | undefined): Promise<void> {
        if (epochBefore === undefined) return;
        try {
            if (await this.cache.get(metricsEpochKey(driverId)) !== epochBefore) return;
            await this.cache.setWithTtl(key, JSON.stringify(metrics), METRICS_CACHE_TTL_SECONDS);
            if (await this.cache.get(metricsEpochKey(driverId)) !== epochBefore) await this.cache.delete(key);
        } catch (error) {
            this.logger.warn(`Could not store the metrics in the cache (${key}). ${error instanceof Error ? error.message : ''}`.trim());
        }
    }

    private toDto(period: DriverMetricsPeriod, range: MetricsDateRange, row: DriverMetricsRow): DriverMetricsDto {
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
