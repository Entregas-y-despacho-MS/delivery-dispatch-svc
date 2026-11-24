import type { AttemptQuality, RescheduleQuality } from '../domain/attempt-quality.js';
import type { OpenCases } from '../domain/case-quality.js';
import type { QualityKpi } from '../domain/kpi.js';

/**
 * What `QualityKpisService` answers (ST-300.1). Plain types: the Swagger DTOs and the endpoint come with the next subtask of
 * ES-300, which maps this into them.
 */
export interface QualityKpisFilters {
    /** First Bolivia day (YYYY-MM-DD), inclusive. */
    from: string;
    /** Last Bolivia day (YYYY-MM-DD), inclusive. */
    to: string;
    zoneId?: number;
    /** Current status of the dispatch. */
    status?: string;
    /** «Motivo»: only incidents with this reason count in the numerator of the incident rate. */
    incidentReasonId?: number;
    /** `true` only dispatches whose window was changed; `false` only the ones that were not; omitted, all. */
    rescheduled?: boolean;
}

export interface QualityKpisOptions {
    /** The caller may read the global rating (decided by the layer that knows the role). */
    ratingsAuthorized: boolean;
    now?: Date;
}

export interface QualityKpisReport {
    period: { from: string; to: string; timeZone: string };
    filters: { zoneId: number | null; status: string | null; incidentReasonId: number | null; rescheduled: boolean | null };
    kpis: {
        incidentRate: QualityKpi;
        rescheduleRate: QualityKpi;
        complaintRate: QualityKpi;
        investigationTime: QualityKpi;
        ratingAverage: QualityKpi;
        responseRate: QualityKpi;
    };
    /** The counts behind the rates that are shown apart and never enter a numerator or denominator. */
    details: {
        attempts: AttemptQuality;
        reschedules: RescheduleQuality & { eligibleDispatchCount: number };
        complaints: { caseCount: number; dispatchesWithCaseCount: number; deliveredDispatchCount: number; decidedWithoutTimestampsCount: number; open: OpenCases };
        /** First moment attempts can be rebuilt from, and whether the whole range is after it. */
        attemptCoverage: { from: string | null; complete: boolean };
    };
}
