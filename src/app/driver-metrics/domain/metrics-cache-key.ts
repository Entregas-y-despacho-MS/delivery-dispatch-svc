import { DriverMetricsPeriod } from './metrics-period.js';

/** Five minutes: the panel may lag a little, but a driver who just delivered sees it at once (the key is invalidated). */
export const METRICS_CACHE_TTL_SECONDS = 5 * 60;

export function metricsCacheKey(driverId: number, period: DriverMetricsPeriod): string {
    return `metrics:driver:${driverId}:${period}`;
}

/** Every key of a driver, for the invalidation when a delivery is confirmed. */
export function allMetricsCacheKeys(driverId: number): string[] {
    return Object.values(DriverMetricsPeriod).map((period) => metricsCacheKey(driverId, period));
}
