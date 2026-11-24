import { Injectable } from '@nestjs/common';
import { OPERATING_TIME_ZONE } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { AttemptsRepository } from '../../delivery-promise/repositories/attempts.repository.js';
import type { DeliveryPromiseFilters } from '../../delivery-promise/repositories/delivery-promise.sql.js';
import { incidentRateKpi, rescheduleRateKpi, summarizeAttemptQuality, summarizeReschedules, type RescheduleRow } from '../domain/attempt-quality.js';
import { complaintRateKpi, investigationTimeKpi, ratingKpi, responseRateKpi, summarizeComplaints } from '../domain/case-quality.js';
import { QualityRepository, type PromiseCohortRow } from '../repositories/quality.repository.js';
import type { QualityKpisFilters, QualityKpisOptions, QualityKpisReport } from '../dto/quality-kpis-report.js';

/** The dispatches that had at least one reschedule that changed their window. */
function rescheduledIds(rows: PromiseCohortRow[]): Set<number> {
    return new Set(rows.filter((row) => row.windowChanged === true).map((row) => row.dispatchId));
}

/**
 * ST-300.1 (ES-300, Dashboard 4) — quality indicators of the delivery: incidents per 100 attempts, reschedules, claims, investigation time
 * and rating. It reads the facts, hands them to the pure rules of `domain/` and returns each indicator with its formula, numerator,
 * denominator, `n` and, when it cannot be told, its N/D cause. Read-only: no table, no cache. Who may call it, and whether the caller
 * may read the global rating (`ratingsAuthorized`), is decided by the layer above (the endpoint of the next subtask).
 *
 * Two cohorts, each labelled in its `dateBasis`: incidents and reschedules are placed by the end of the promise window (as ST-301.3
 * does); claims and ratings by the closing of the delivery.
 */
@Injectable()
export class QualityKpisService {
    constructor(
        private readonly attempts: AttemptsRepository,
        private readonly quality: QualityRepository,
    ) {}

    async getQualityKpis(filters: QualityKpisFilters, options: QualityKpisOptions): Promise<QualityKpisReport> {
        const now = options.now ?? new Date();
        const base: DeliveryPromiseFilters = { from: filters.from, to: filters.to, zoneId: filters.zoneId, status: filters.status };

        const [cohortRows, deliveredRows, sources, coverage] = await Promise.all([
            this.quality.listPromiseCohort(base),
            this.quality.listDeliveredCohort(base),
            this.attempts.listSources(base),
            this.attempts.findCoverage(filters.from),
        ]);

        // «Reprogramación» filter: by whether the window of the dispatch was ever changed, the same on every indicator.
        const rescheduled = rescheduledIds(cohortRows);
        const keep = (dispatchId: number, wasRescheduled: boolean) => filters.rescheduled === undefined || filters.rescheduled === wasRescheduled;
        const cohort = cohortRows.filter((row) => keep(row.dispatchId, rescheduled.has(row.dispatchId)));
        const cohortSources = sources.filter((source) => keep(source.dispatchId, rescheduled.has(source.dispatchId)));
        const delivered = deliveredRows.filter((row) => keep(row.dispatchId, row.rescheduled));
        const deliveredIds = delivered.map((row) => row.dispatchId);

        const eligibleIds = new Set(cohort.filter((row) => !row.cancelled).map((row) => row.dispatchId));
        const rescheduleRows: RescheduleRow[] = cohort
            .filter((row) => row.windowChanged !== null && eligibleIds.has(row.dispatchId))
            .map((row) => ({ dispatchId: row.dispatchId, windowChanged: row.windowChanged === true }));

        const incidentFilter = filters.incidentReasonId === undefined
            ? undefined
            : await this.quality.listIncidentIdsByReason(filters.incidentReasonId, cohortSources.map((source) => source.dispatchId));
        const [cases, scores] = await Promise.all([this.quality.listComplaintCases(deliveredIds), this.quality.listRatingScores(deliveredIds)]);

        const attemptQuality = summarizeAttemptQuality(cohortSources, incidentFilter);
        const rescheduleQuality = summarizeReschedules(rescheduleRows);
        const complaintQuality = summarizeComplaints(cases, now);

        return {
            period: { from: filters.from, to: filters.to, timeZone: OPERATING_TIME_ZONE },
            filters: {
                zoneId: filters.zoneId ?? null, status: filters.status ?? null,
                incidentReasonId: filters.incidentReasonId ?? null, rescheduled: filters.rescheduled ?? null,
            },
            kpis: {
                incidentRate: incidentRateKpi(attemptQuality, coverage.complete),
                rescheduleRate: rescheduleRateKpi(rescheduleQuality, eligibleIds.size),
                complaintRate: complaintRateKpi(complaintQuality, deliveredIds.length),
                investigationTime: investigationTimeKpi(complaintQuality),
                ratingAverage: ratingKpi(scores, options.ratingsAuthorized),
                responseRate: responseRateKpi(),
            },
            details: {
                attempts: attemptQuality,
                reschedules: { ...rescheduleQuality, eligibleDispatchCount: eligibleIds.size },
                complaints: {
                    caseCount: complaintQuality.caseCount, dispatchesWithCaseCount: complaintQuality.dispatchesWithCaseCount,
                    deliveredDispatchCount: deliveredIds.length, decidedWithoutTimestampsCount: complaintQuality.decidedWithoutTimestampsCount,
                    open: complaintQuality.open,
                },
                attemptCoverage: { from: coverage.from ? coverage.from.toISOString() : null, complete: coverage.complete },
            },
        };
    }
}
