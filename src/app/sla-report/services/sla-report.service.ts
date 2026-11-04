import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../../../plugins/cache/cache.port.js';
import { SLA_REPORT_CACHE_TTL_SECONDS, slaReportCacheKey } from '../domain/sla-cache-key.js';
import { assertSlaRange } from '../domain/sla-date-range.js';
import type { SlaGroupBy } from '../domain/sla-group-by.js';
import { buildSlaReport, isSlaReportOf } from '../domain/sla-metrics.js';
import type { SlaReportDto } from '../dto/sla-report.dto.js';
import { SlaReportRepository } from '../repositories/sla-report.repository.js';

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : '';
}

/**
 * The SLA compliance report (RF-A07), also the base of the fleet KPIs (ST-61.1) and the fleet report (ST-65.1), which
 * reuse `aggregate` for the `driver` grouping. The answer is served from Redis when it is there; the cache is only an
 * accelerator, so a Redis that does not answer, or an entry that is not a report of this range and grouping, never
 * fails the request: it is answered from PostgreSQL with a warning. Nothing invalidates the entry; it expires on its own.
 */
@Injectable()
export class SlaReportService {
    private readonly logger = new Logger(SlaReportService.name);

    constructor(
        private readonly repository: SlaReportRepository,
        private readonly cache: CacheService,
    ) {}

    /**
     * The report of the range, from the cache when there. The range is checked first, so an invalid one touches
     * neither Redis nor PostgreSQL.
     */
    async aggregate(from: string, to: string, groupBy: SlaGroupBy): Promise<SlaReportDto> {
        assertSlaRange(from, to);
        const key = slaReportCacheKey(groupBy, from, to);
        const cached = await this.read(key, from, to, groupBy);
        if (cached) return cached;

        const report = await this.build(from, to, groupBy);
        await this.write(key, report);
        return report;
    }

    /** The report straight from PostgreSQL, without reading or writing the cache. */
    async compute(from: string, to: string, groupBy: SlaGroupBy): Promise<SlaReportDto> {
        assertSlaRange(from, to);
        return await this.build(from, to, groupBy);
    }

    private async build(from: string, to: string, groupBy: SlaGroupBy): Promise<SlaReportDto> {
        return buildSlaReport(from, to, groupBy, await this.repository.aggregate(groupBy, from, to));
    }

    private async read(key: string, from: string, to: string, groupBy: SlaGroupBy): Promise<SlaReportDto | null> {
        try {
            const raw = await this.cache.get(key);
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            if (isSlaReportOf(parsed, from, to, groupBy)) return parsed;
            // Whatever is there is recomputed and overwritten.
            this.logger.warn(`The cached SLA report under ${key} is not valid; computing from PostgreSQL.`);
        } catch (error) {
            this.logger.warn(`Could not read the SLA report cache (${key}); computing from PostgreSQL. ${messageOf(error)}`.trim());
        }
        return null;
    }

    private async write(key: string, report: SlaReportDto): Promise<void> {
        try {
            await this.cache.setWithTtl(key, JSON.stringify(report), SLA_REPORT_CACHE_TTL_SECONDS);
        } catch (error) {
            this.logger.warn(`Could not store the SLA report in the cache (${key}). ${messageOf(error)}`.trim());
        }
    }
}
