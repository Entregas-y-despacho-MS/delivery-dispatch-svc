import { normalizeAttempts, type AttemptEvent } from '../../delivery-promise/domain/first-attempt.js';
import { KpiUnavailableReason, rateKpi, type QualityKpi } from './kpi.js';

export const INCIDENT_KPI_DATE_BASIS = 'promise_window_end';
export const RESCHEDULE_KPI_DATE_BASIS = 'promise_window_end';

/** The events of one dispatch of the cohort, as `AttemptsRepository` reads them. */
export interface QualitySource {
    dispatchId: number;
    events: AttemptEvent[];
}

export interface AttemptQuality {
    /** Valid attempts rebuilt from the events (the denominator). */
    attemptCount: number;
    /** Attempts with at least one incident that consumes an attempt (the numerator): two incidents of one attempt count once. */
    attemptsWithIncidentCount: number;
    /** Dispatches with at least one of those attempts. */
    dispatchesWithIncidentCount: number;
    /** Distinct incident events that consume an attempt, before collapsing them by attempt (shown apart, never in the rate). */
    incidentEventCount: number;
    /** Distinct incidents whose reason does not consume an attempt: they are not an attempt, so they are outside the rate. */
    incidentsWithoutAttemptCount: number;
    /** Dispatches whose history cannot be turned into attempts; out of both sides of the rate. */
    notReconstructableCount: number;
}

const INCIDENT = 'incident';

/** Distinct events by `client_event_id` (the offline retry key) or, without one, by `dispatch_event_id`. */
function distinctIncidentKeys(events: AttemptEvent[], countsAsAttempt: boolean): Set<string> {
    const keys = new Set<string>();
    for (const event of events) {
        if (event.status === INCIDENT && event.countsAsAttempt === countsAsAttempt) keys.add(event.clientEventId ?? `event-${event.eventId}`);
    }
    return keys;
}

/** Counts per attempt and per dispatch, never per event row. Reuses the attempt rule of ST-301.3. */
export function summarizeAttemptQuality(sources: QualitySource[]): AttemptQuality {
    const quality: AttemptQuality = {
        attemptCount: 0, attemptsWithIncidentCount: 0, dispatchesWithIncidentCount: 0,
        incidentEventCount: 0, incidentsWithoutAttemptCount: 0, notReconstructableCount: 0,
    };
    for (const source of sources) {
        const history = normalizeAttempts(source.events);
        if (!history.reconstructable) {
            quality.notReconstructableCount += 1;
            continue;
        }
        const withIncident = history.attempts.filter((attempt) => attempt.hadIncident).length;
        quality.attemptCount += history.attempts.length;
        quality.attemptsWithIncidentCount += withIncident;
        if (withIncident > 0) quality.dispatchesWithIncidentCount += 1;
        quality.incidentEventCount += distinctIncidentKeys(source.events, true).size;
        quality.incidentsWithoutAttemptCount += distinctIncidentKeys(source.events, false).size;
    }
    return quality;
}

/** Incidents per 100 attempts. N/D when the range starts before the instrumented period (no attempt can be rebuilt there). */
export function incidentRateKpi(quality: AttemptQuality, coverageComplete: boolean): QualityKpi {
    return rateKpi({
        code: 'incident_rate',
        formula: 'attempts with at least one incident / valid attempts × 100',
        dateBasis: INCIDENT_KPI_DATE_BASIS,
        numerator: quality.attemptsWithIncidentCount,
        denominator: quality.attemptCount,
        unavailableReason: coverageComplete ? null : KpiUnavailableReason.ATTEMPT_COVERAGE_INCOMPLETE,
    });
}

/** One row of `dispatch_reschedules` of a dispatch in the cohort. `windowChanged` is false for a route reassignment. */
export interface RescheduleRow {
    dispatchId: number;
    windowChanged: boolean;
}

export interface RescheduleQuality {
    /** Unique dispatches rescheduled at least once (the numerator). */
    rescheduledDispatchCount: number;
    /** Reschedule events with a window change, shown apart: they never raise the denominator. */
    rescheduleEventCount: number;
    /** Rows that only moved the route: not a reschedule. */
    reassignmentOnlyCount: number;
}

export function summarizeReschedules(rows: RescheduleRow[]): RescheduleQuality {
    const dispatches = new Set<number>();
    let events = 0;
    let reassignments = 0;
    for (const row of rows) {
        if (!row.windowChanged) {
            reassignments += 1;
            continue;
        }
        events += 1;
        dispatches.add(row.dispatchId);
    }
    return { rescheduledDispatchCount: dispatches.size, rescheduleEventCount: events, reassignmentOnlyCount: reassignments };
}

/** Rescheduled unique dispatches over the unique eligible dispatches of the cohort. */
export function rescheduleRateKpi(quality: RescheduleQuality, eligibleDispatchCount: number): QualityKpi {
    return rateKpi({
        code: 'reschedule_rate',
        formula: 'unique eligible dispatches rescheduled / unique eligible dispatches of the cohort × 100',
        dateBasis: RESCHEDULE_KPI_DATE_BASIS,
        numerator: quality.rescheduledDispatchCount,
        denominator: eligibleDispatchCount,
    });
}
