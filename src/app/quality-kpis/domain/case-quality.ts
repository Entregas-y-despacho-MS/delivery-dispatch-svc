import { KpiUnavailableReason, KpiUnit, median, rateKpi, round2, unavailableKpi, type QualityKpi } from './kpi.js';

export const COMPLAINT_KPI_DATE_BASIS = 'closed_at';
export const RATING_KPI_DATE_BASIS = 'closed_at';
const MS_PER_MINUTE = 60_000;

/** One CRM case tied to a delivered dispatch of the cohort (`delivery_complaint_cases`). */
export interface ComplaintCaseRow {
    caseId: number;
    dispatchId: number;
    openedAt: Date;
    investigationStartedAt: Date | null;
    decidedAt: Date | null;
}

export interface OpenCases {
    count: number;
    /** Age in minutes of the oldest open case; null with none. */
    oldestAgeMinutes: number | null;
}

export interface ComplaintQuality {
    /** Valid cases, one per `caseId`, tied to delivered dispatches (the numerator). */
    caseCount: number;
    /** Delivered dispatches with at least one case. */
    dispatchesWithCaseCount: number;
    /** Minutes from `investigationStartedAt` to `decidedAt`, only for cases with both. */
    investigationMinutes: number[];
    /** Decided cases that miss a timestamp: out of the median and shown apart. */
    decidedWithoutTimestampsCount: number;
    open: OpenCases;
}

export function summarizeComplaints(rows: ComplaintCaseRow[], now: Date): ComplaintQuality {
    const byCase = new Map<number, ComplaintCaseRow>();
    for (const row of rows) if (!byCase.has(row.caseId)) byCase.set(row.caseId, row);

    const quality: ComplaintQuality = {
        caseCount: byCase.size, dispatchesWithCaseCount: new Set([...byCase.values()].map((c) => c.dispatchId)).size,
        investigationMinutes: [], decidedWithoutTimestampsCount: 0, open: { count: 0, oldestAgeMinutes: null },
    };
    for (const row of byCase.values()) {
        if (row.decidedAt === null) {
            quality.open.count += 1;
            const age = Math.max(0, Math.floor((now.getTime() - row.openedAt.getTime()) / MS_PER_MINUTE));
            quality.open.oldestAgeMinutes = Math.max(quality.open.oldestAgeMinutes ?? 0, age);
            continue;
        }
        if (row.investigationStartedAt === null || row.decidedAt.getTime() < row.investigationStartedAt.getTime()) {
            quality.decidedWithoutTimestampsCount += 1;
            continue;
        }
        quality.investigationMinutes.push((row.decidedAt.getTime() - row.investigationStartedAt.getTime()) / MS_PER_MINUTE);
    }
    return quality;
}

/** Cases over the unique delivered dispatches of the cohort: orders and batches are never the unit. */
export function complaintRateKpi(quality: ComplaintQuality, deliveredDispatchCount: number): QualityKpi {
    return rateKpi({
        code: 'complaint_rate',
        formula: 'valid deduplicated CRM cases on delivered dispatches / unique delivered dispatches of the cohort × 100',
        dateBasis: COMPLAINT_KPI_DATE_BASIS,
        numerator: quality.caseCount,
        denominator: deliveredDispatchCount,
    });
}

/** Median investigation time. Open cases are not in it; N/D when cases were decided but none has both timestamps. */
export function investigationTimeKpi(quality: ComplaintQuality): QualityKpi {
    const code = 'investigation_median_minutes';
    const formula = 'median of (decidedAt - investigationStartedAt) over cases with both timestamps';
    const n = quality.investigationMinutes.length;
    if (n === 0 && quality.decidedWithoutTimestampsCount > 0) {
        return unavailableKpi({ code, formula, dateBasis: COMPLAINT_KPI_DATE_BASIS, unit: KpiUnit.MINUTES, reason: KpiUnavailableReason.INVESTIGATION_TIMESTAMP_MISSING });
    }
    const value = median(quality.investigationMinutes);
    return {
        code, formula, unit: KpiUnit.MINUTES, numerator: null, denominator: null, n,
        value: value === null ? null : round2(value), available: true, reason: null, dateBasis: COMPLAINT_KPI_DATE_BASIS,
    };
}

/** Average rating of the delivered dispatches of the cohort. Omitted (N/D, no figure) unless the caller may read the global rating. */
export function ratingKpi(scores: number[], authorized: boolean): QualityKpi {
    const code = 'rating_average';
    const formula = 'mean score of the ratings of the delivered dispatches of the cohort';
    if (!authorized) return unavailableKpi({ code, formula, dateBasis: RATING_KPI_DATE_BASIS, unit: KpiUnit.SCORE, reason: KpiUnavailableReason.RATING_NOT_AUTHORIZED });
    const n = scores.length;
    return {
        code, formula, unit: KpiUnit.SCORE, numerator: n === 0 ? null : scores.reduce((sum, s) => sum + s, 0), denominator: n === 0 ? null : n, n,
        value: n === 0 ? null : round2(scores.reduce((sum, s) => sum + s, 0) / n), available: true, reason: null, dateBasis: RATING_KPI_DATE_BASIS,
    };
}

/** There is no record of who could answer, so the response rate cannot be told. */
export function responseRateKpi(): QualityKpi {
    return unavailableKpi({
        code: 'response_rate',
        formula: 'ratings received / delivered dispatches with an opportunity to answer × 100',
        dateBasis: RATING_KPI_DATE_BASIS,
        unit: KpiUnit.PERCENT,
        reason: KpiUnavailableReason.RESPONSE_OPPORTUNITY_NOT_RECORDED,
    });
}
