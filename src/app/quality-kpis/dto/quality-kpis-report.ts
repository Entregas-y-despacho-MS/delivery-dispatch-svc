import type { AttemptQuality, RescheduleQuality } from '../domain/attempt-quality.js';
import type { OpenCases } from '../domain/case-quality.js';
import type { QualityKpi } from '../domain/kpi.js';
import type { Page, QualityCaseItem, QualityDispatchItem, TableOrder } from '../domain/quality-tables.js';

/**
 * What `QualityKpisService` answers (ST-300.1, extended by ST-300.2). Plain types: the Swagger DTOs of the endpoint
 * (`quality-kpis-response.dto.ts`) mirror them field by field.
 */
export interface QualityKpisFilters {
    /** First Bolivia day (YYYY-MM-DD), inclusive. */
    from: string;
    /** Last Bolivia day (YYYY-MM-DD), inclusive. */
    to: string;
    zoneId?: number;
    /**
     * Current status of the dispatch, applied to every cohort. Claims and rating only look at delivered dispatches, so any other status leaves them
     * in «Sin datos»; `delivered` leaves incidents and reschedules measuring only the dispatches that ended well.
     */
    status?: string;
    /** «Motivo»: only incidents with this reason count in the numerator of the incident rate. */
    incidentReasonId?: number;
    /** Reason code of the CRM complaint (exact, case-insensitive): only those cases count in the complaint indicators. Delivered dispatches stay the denominator. */
    reasonCode?: string;
    /** `true` only dispatches whose window was changed; `false` only the ones that were not; omitted, all. */
    rescheduled?: boolean;
}

export interface QualityKpisOptions {
    /** The caller may read the global rating (decided by the layer that knows the role). */
    ratingsAuthorized: boolean;
    now?: Date;
    /** Page of both tables (default 1) and its size (default 10, at most 100: the endpoint validates it). */
    page?: number;
    limit?: number;
    /** Order of both tables by their id (default `desc`). */
    order?: TableOrder;
}

export interface QualityKpisReport {
    period: { from: string; to: string; timeZone: string };
    filters: { zoneId: number | null; status: string | null; incidentReasonId: number | null; reasonCode: string | null; rescheduled: boolean | null };
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
    /** The cases and the dispatches, apart, with the same filters as the indicators. No personal data and no evidence URL. */
    tables: { cases: Page<QualityCaseItem>; dispatches: Page<QualityDispatchItem> };
    /** Tables each figure was read from; `dispatch_ratings` only when the caller may read the rating. */
    sources: string[];
}
