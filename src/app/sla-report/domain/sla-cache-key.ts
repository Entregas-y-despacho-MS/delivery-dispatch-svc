import type { SlaGroupBy } from './sla-group-by.js';

/** Ten minutes. Nothing invalidates the entry: a delivery confirmed now shows up in the report when the entry expires. */
export const SLA_REPORT_CACHE_TTL_SECONDS = 10 * 60;

/** One entry per grouping and range: the same query from two screens (or from ST-61.1 / ST-65.1) shares it. */
export function slaReportCacheKey(groupBy: SlaGroupBy, from: string, to: string): string {
    return `reports:sla:${groupBy}:${from}:${to}`;
}
