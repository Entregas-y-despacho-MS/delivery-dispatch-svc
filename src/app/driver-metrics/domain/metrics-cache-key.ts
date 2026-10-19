import { DriverMetricsPeriod } from './metrics-period.js';

/** Five minutes: the panel may lag a little, but a driver who just delivered sees it at once (the key is invalidated). */
export const METRICS_CACHE_TTL_SECONDS = 5 * 60;

export function metricsCacheKey(driverId: number, period: DriverMetricsPeriod): string {
    return `metrics:driver:${driverId}:${period}`;
}

/**
 * Counter bumped on every invalidation of a driver. A request that computed its answer while the counter moved
 * knows a delivery was confirmed meanwhile and must not leave that (possibly stale) answer in the cache. It lives
 * longer than any cached answer, so it cannot expire while one computed under it is still stored.
 */
export const METRICS_EPOCH_TTL_SECONDS = 2 * METRICS_CACHE_TTL_SECONDS;

export function metricsEpochKey(driverId: number): string {
    return `metrics:driver:${driverId}:epoch`;
}

/** Every cached answer of a driver, for the invalidation when a delivery is confirmed. */
export function allMetricsCacheKeys(driverId: number): string[] {
    return Object.values(DriverMetricsPeriod).map((period) => metricsCacheKey(driverId, period));
}
