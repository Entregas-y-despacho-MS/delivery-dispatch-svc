export const FLEET_REPORTS_CACHE_TTL_SECONDS = 600;

export function fleetReportsCacheKey(from: string, to: string): string {
    return `reports:fleet:${from}:${to}`;
}
