import { describe, expect, it } from 'vitest';
import { SLA_REPORT_CACHE_TTL_SECONDS, slaReportCacheKey } from './sla-cache-key.js';
import { SlaGroupBy } from './sla-group-by.js';

describe('slaReportCacheKey', () => {
    it('is derived from the grouping and the range', () => {
        expect(slaReportCacheKey(SlaGroupBy.ZONE, '2026-10-01', '2026-10-31')).toBe('reports:sla:zone:2026-10-01:2026-10-31');
        expect(slaReportCacheKey(SlaGroupBy.SERVICE_LEVEL, '2026-10-01', '2026-10-31')).toBe('reports:sla:service_level:2026-10-01:2026-10-31');
    });

    it('differs when any of the three parameters differs', () => {
        const keys = new Set([
            slaReportCacheKey(SlaGroupBy.ZONE, '2026-10-01', '2026-10-31'),
            slaReportCacheKey(SlaGroupBy.DRIVER, '2026-10-01', '2026-10-31'),
            slaReportCacheKey(SlaGroupBy.ZONE, '2026-10-02', '2026-10-31'),
            slaReportCacheKey(SlaGroupBy.ZONE, '2026-10-01', '2026-10-30'),
        ]);
        expect(keys.size).toBe(4);
    });

    it('expires in ten minutes', () => {
        expect(SLA_REPORT_CACHE_TTL_SECONDS).toBe(600);
    });
});
