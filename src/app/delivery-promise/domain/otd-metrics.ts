import { round1 } from '../../sla-report/domain/sla-metrics.js';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { CANCELLATION_EXCLUSION_REASON, FIRST_ATTEMPT_UNAVAILABLE_REASON, OTD_DATE_BASIS, type OtdBasis } from './otd-basis.js';
import type { AppliedFiltersDto, OtdMetricsDto, OtdReportDto } from '../dto/otd-report.dto.js';

/** What PostgreSQL returns for one query: only counts, the rate is built here. */
export interface OtdCounts {
    /** Denominator: the dispatches that make up the universe of the rate. */
    eligible: number;
    /** Numerator: the eligible ones delivered inside their committed window. */
    onTime: number;
    /** Dispatches whose window is missing or ends before it starts: shown apart, never counted as 0 or as late. */
    invalidWindow: number;
    /** Cancelled before their promise expired: out of the denominator. */
    excludedCancellations: number;
    /** Cancelled with no window to tell whether the promise had expired: out of the rate, which is then not reliable. */
    unreconstructableCancellations: number;
    /** Eligible dispatches whose window was changed after it was first promised: they are measured against the one in force. */
    rescheduledPromise: number;
}

/**
 * Over the eligible ones, one decimal. 1999 of 2000 would round to 100.0 and it is shown as 99.9, so 100 always means
 * «none out of the window» (same rule as ES-54). With no eligible dispatch there is no rate: `null` is «Sin datos», not 0.
 */
function percentage(onTime: number, eligible: number): number | null {
    if (eligible === 0) return null;
    const value = round1((onTime / eligible) * 100);
    return onTime < eligible && value === 100 ? 99.9 : value;
}

/** The filters of a query as the answer repeats them: what was not asked is `null`, not missing. */
export function appliedFilters(filters: { zoneId?: number; serviceLevelId?: number; status?: string }): AppliedFiltersDto {
    return { zoneId: filters.zoneId ?? null, serviceLevelId: filters.serviceLevelId ?? null, status: filters.status ?? null };
}

/** The full answer of an OTD query: the rate with the date basis, the time zone and the cut it was measured at. */
export function buildOtdReport(basis: OtdBasis, query: { from: string; to: string; zoneId?: number; serviceLevelId?: number; status?: string }, counts: OtdCounts, now: Date): OtdReportDto {
    const metrics = buildOtdMetrics(counts);
    return {
        from: query.from,
        to: query.to,
        basis,
        dateBasis: OTD_DATE_BASIS[basis],
        timeZone: OPERATING_TIME_ZONE,
        asOf: now.toISOString(),
        filters: appliedFilters(query),
        metrics,
        firstAttempt: { available: false, reason: FIRST_ATTEMPT_UNAVAILABLE_REASON },
        empty: counts.eligible === 0 && counts.invalidWindow === 0 && counts.excludedCancellations === 0 && counts.unreconstructableCancellations === 0,
    };
}

export function buildOtdMetrics(counts: OtdCounts): OtdMetricsDto {
    return {
        numerator: counts.onTime,
        denominator: counts.eligible,
        n: counts.eligible,
        percentage: percentage(counts.onTime, counts.eligible),
        notOnTimeCount: counts.eligible - counts.onTime,
        invalidWindowCount: counts.invalidWindow,
        excludedCancellations: { count: counts.excludedCancellations, reason: CANCELLATION_EXCLUSION_REASON },
        unreconstructableCancellationCount: counts.unreconstructableCancellations,
        rescheduledPromiseCount: counts.rescheduledPromise,
    };
}
