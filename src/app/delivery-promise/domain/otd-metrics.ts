import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { CANCELLATION_EXCLUSION_REASON_BY_BASIS, OTD_DATE_BASIS, OtdBasis } from './otd-basis.js';
import { unavailableFirstAttempt } from './first-attempt.js';
import { percentage } from './percentage.js';
import type { AppliedFiltersDto, FirstAttemptDto, OtdMetricsDto, OtdReportDto } from '../dto/otd-report.dto.js';

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

/** The filters of a query as the answer repeats them: what was not asked is `null`, not missing. */
export function appliedFilters(filters: { zoneId?: number; serviceLevelId?: number; status?: string }): AppliedFiltersDto {
    return { zoneId: filters.zoneId ?? null, serviceLevelId: filters.serviceLevelId ?? null, status: filters.status ?? null };
}

/** The full answer of an OTD query: the rate with the date basis, the time zone and the cut it was measured at. */
export function buildOtdReport(basis: OtdBasis, query: { from: string; to: string; zoneId?: number; serviceLevelId?: number; status?: string }, counts: OtdCounts, now: Date, firstAttempt: FirstAttemptDto = unavailableFirstAttempt()): OtdReportDto {
    const metrics = buildOtdMetrics(counts, basis);
    return {
        from: query.from,
        to: query.to,
        basis,
        dateBasis: OTD_DATE_BASIS[basis],
        timeZone: OPERATING_TIME_ZONE,
        asOf: now.toISOString(),
        filters: appliedFilters(query),
        metrics,
        firstAttempt,
        empty: counts.eligible === 0 && counts.invalidWindow === 0 && counts.excludedCancellations === 0 && counts.unreconstructableCancellations === 0,
    };
}

export function buildOtdMetrics(counts: OtdCounts, basis: OtdBasis = OtdBasis.PROMISE): OtdMetricsDto {
    return {
        numerator: counts.onTime,
        denominator: counts.eligible,
        n: counts.eligible,
        percentage: percentage(counts.onTime, counts.eligible),
        notOnTimeCount: counts.eligible - counts.onTime,
        invalidWindowCount: counts.invalidWindow,
        excludedCancellations: { count: counts.excludedCancellations, reason: CANCELLATION_EXCLUSION_REASON_BY_BASIS[basis] },
        unreconstructableCancellationCount: counts.unreconstructableCancellations,
        rescheduledPromiseCount: counts.rescheduledPromise,
    };
}
