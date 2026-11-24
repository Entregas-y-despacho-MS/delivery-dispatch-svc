import { describe, expect, it, vi } from 'vitest';
import type { AttemptEvent } from '../../delivery-promise/domain/first-attempt.js';
import type { DispatchAttemptSource } from '../../delivery-promise/repositories/attempts.repository.js';
import type { ComplaintCaseRow } from '../domain/case-quality.js';
import { KpiUnavailableReason } from '../domain/kpi.js';
import type { PromiseCohortRow } from '../repositories/quality.repository.js';
import { QualityKpisService } from './quality-kpis.service.js';

let nextId = 1;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, minutes));
const event = (status: string, minutes: number, overrides: Partial<AttemptEvent> = {}): AttemptEvent =>
    ({ eventId: nextId++, clientEventId: null, occurredAt: at(minutes), previousStatus: null, status, countsAsAttempt: false, ...overrides });
const incident = (minutes: number, id: string) => event('incident', minutes, { clientEventId: id, countsAsAttempt: true });
const source = (dispatchId: number, events: AttemptEvent[]): DispatchAttemptSource => ({ dispatchId, status: 'delivered', windowStart: null, windowEnd: null, events });
const cohort = (dispatchId: number, windowChanged: boolean | null = null, cancelled = false): PromiseCohortRow => ({ dispatchId, cancelled, windowChanged });
const caseRow = (caseId: number, dispatchId: number, overrides: Partial<ComplaintCaseRow> = {}): ComplaintCaseRow =>
    ({ caseId, dispatchId, openedAt: new Date('2026-11-20T10:00:00Z'), investigationStartedAt: null, decidedAt: null, ...overrides });

const NOW = new Date('2026-11-24T12:00:00Z');
const FILTERS = { from: '2026-11-01', to: '2026-11-30' };

interface Fixture {
    cohortRows?: PromiseCohortRow[];
    delivered?: { dispatchId: number; rescheduled: boolean }[];
    sources?: DispatchAttemptSource[];
    coverageComplete?: boolean;
    cases?: ComplaintCaseRow[];
    scores?: number[];
    incidentIds?: Set<string>;
}

function build(fixture: Fixture = {}) {
    const attempts = {
        listSources: vi.fn().mockResolvedValue(fixture.sources ?? []),
        findCoverage: vi.fn().mockResolvedValue({ from: new Date('2026-10-01T00:00:00Z'), complete: fixture.coverageComplete ?? true }),
    };
    const quality = {
        listPromiseCohort: vi.fn().mockResolvedValue(fixture.cohortRows ?? []),
        listDeliveredCohort: vi.fn().mockResolvedValue(fixture.delivered ?? []),
        listComplaintCases: vi.fn().mockResolvedValue(fixture.cases ?? []),
        listRatingScores: vi.fn().mockResolvedValue(fixture.scores ?? []),
        listIncidentIdsByReason: vi.fn().mockResolvedValue(fixture.incidentIds ?? new Set<string>()),
    };
    return { service: new QualityKpisService(attempts as any, quality as any), attempts, quality };
}

describe('QualityKpisService.getQualityKpis', () => {
    // 4 delivery dispatches in the promise cohort; d1 rescheduled twice (window) + once (route only); d2 rescheduled once; d4 cancelled.
    const referenceCohort = [cohort(1, true), cohort(1, true), cohort(1, false), cohort(2, true), cohort(3), cohort(4, true, true)];
    const referenceSources = [
        source(1, [event('in_transit', 0), incident(5, 'i-1'), incident(6, 'i-2'), event('in_transit', 60), event('delivered', 70)]),
        source(2, [event('in_transit', 0), event('delivered', 10)]),
        source(3, [event('in_transit', 0), event('not_delivered', 10), incident(11, 'i-3')]),
    ];

    it('recomputes the reference case by hand: 4 attempts, 2 with incident (50); 2 of 3 eligible rescheduled (66.7); 2 cases over 10 delivered (20)', () => {
        const { service } = build({
            cohortRows: referenceCohort, sources: referenceSources,
            delivered: Array.from({ length: 10 }, (_, i) => ({ dispatchId: 100 + i, rescheduled: false })),
            cases: [caseRow(1, 100), caseRow(2, 101)], scores: [5, 4, 3],
        });
        return service.getQualityKpis(FILTERS, { ratingsAuthorized: true, now: NOW }).then((report) => {
            const { incidentRate, rescheduleRate, complaintRate, ratingAverage } = report.kpis;
            expect([incidentRate.numerator, incidentRate.denominator, incidentRate.value]).toEqual([2, 4, 50]);
            expect([rescheduleRate.numerator, rescheduleRate.denominator, rescheduleRate.value]).toEqual([2, 3, 66.7]);
            expect(report.details.reschedules).toMatchObject({ rescheduleEventCount: 3, reassignmentOnlyCount: 1, eligibleDispatchCount: 3 });
            expect([complaintRate.numerator, complaintRate.denominator, complaintRate.n, complaintRate.value]).toEqual([2, 10, 10, 20]);
            expect(ratingAverage).toMatchObject({ value: 4, n: 3 });
            expect(report.period).toEqual({ from: '2026-11-01', to: '2026-11-30', timeZone: 'America/La_Paz' });
        });
    });

    it('shows N/D with the cause, keeping the counts, when the range starts before the instrumented period', async () => {
        const { service } = build({ cohortRows: referenceCohort, sources: referenceSources, coverageComplete: false });
        const report = await service.getQualityKpis(FILTERS, { ratingsAuthorized: false, now: NOW });
        expect(report.kpis.incidentRate).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.ATTEMPT_COVERAGE_INCOMPLETE, numerator: 2, denominator: 4 });
    });

    it('omits the rating with its cause when the caller is not authorized, and the response rate is N/D', async () => {
        const { service, quality } = build({ delivered: [{ dispatchId: 1, rescheduled: false }], scores: [5] });
        const report = await service.getQualityKpis(FILTERS, { ratingsAuthorized: false, now: NOW });
        expect(report.kpis.ratingAverage).toMatchObject({ available: false, value: null, n: 0, reason: KpiUnavailableReason.RATING_NOT_AUTHORIZED });
        expect(quality.listRatingScores).not.toHaveBeenCalled();
        expect(report.kpis.responseRate).toMatchObject({ available: false, reason: KpiUnavailableReason.RESPONSE_OPPORTUNITY_NOT_RECORDED });
    });

    it('is Sin datos, not 0, with nothing in the period; open cases stay as a count', async () => {
        const empty = await build().service.getQualityKpis(FILTERS, { ratingsAuthorized: true, now: NOW });
        for (const kpi of [empty.kpis.incidentRate, empty.kpis.rescheduleRate, empty.kpis.complaintRate, empty.kpis.investigationTime, empty.kpis.ratingAverage]) {
            expect(kpi).toMatchObject({ available: true, value: null });
        }
        const open = await build({ delivered: [{ dispatchId: 1, rescheduled: false }], cases: [caseRow(1, 1)] }).service.getQualityKpis(FILTERS, { ratingsAuthorized: true, now: NOW });
        expect(open.details.complaints.open).toEqual({ count: 1, oldestAgeMinutes: (4 * 24 + 2) * 60 });
        expect(open.kpis.investigationTime).toMatchObject({ available: true, value: null, n: 0 });
    });

    it('«reprogramación» filter keeps only the dispatches whose window changed, on every indicator', async () => {
        const { service, quality } = build({
            cohortRows: referenceCohort, sources: referenceSources,
            delivered: [{ dispatchId: 1, rescheduled: true }, { dispatchId: 5, rescheduled: false }],
        });
        const report = await service.getQualityKpis({ ...FILTERS, rescheduled: true }, { ratingsAuthorized: true, now: NOW });
        expect(report.details.attempts.attemptCount).toBe(3); // d1 (2 attempts) and d2 (1); d3 was never rescheduled
        expect(report.kpis.rescheduleRate).toMatchObject({ numerator: 2, denominator: 2, value: 100 });
        expect(quality.listComplaintCases).toHaveBeenCalledWith([1]);

        const notRescheduled = await service.getQualityKpis({ ...FILTERS, rescheduled: false }, { ratingsAuthorized: true, now: NOW });
        expect(notRescheduled.kpis.rescheduleRate).toMatchObject({ numerator: 0, denominator: 1, value: 0 });
        expect(quality.listComplaintCases).toHaveBeenLastCalledWith([5]);
    });

    it('«motivo» filter narrows the numerator to the incidents with that reason and leaves the denominator', async () => {
        const { service, quality } = build({ cohortRows: referenceCohort, sources: referenceSources, incidentIds: new Set(['i-3']) });
        const report = await service.getQualityKpis({ ...FILTERS, incidentReasonId: 7 }, { ratingsAuthorized: true, now: NOW });
        expect(quality.listIncidentIdsByReason).toHaveBeenCalledWith(7, [1, 2, 3]);
        expect(report.kpis.incidentRate).toMatchObject({ numerator: 1, denominator: 4, value: 25 });
        expect(report.filters).toMatchObject({ incidentReasonId: 7, rescheduled: null });
    });

    it('passes the zone and status filters to the sources and the cohorts, never the service level', async () => {
        const { service, attempts, quality } = build();
        await service.getQualityKpis({ ...FILTERS, zoneId: 3, status: 'delivered' }, { ratingsAuthorized: true, now: NOW });
        const expected = { from: '2026-11-01', to: '2026-11-30', zoneId: 3, status: 'delivered' };
        expect(attempts.listSources).toHaveBeenCalledWith(expected);
        expect(quality.listPromiseCohort).toHaveBeenCalledWith(expected);
        expect(quality.listDeliveredCohort).toHaveBeenCalledWith(expected);
        expect(attempts.findCoverage).toHaveBeenCalledWith('2026-11-01');
    });

    it('a cancelled dispatch is not an eligible dispatch, and its reschedules are not counted', async () => {
        const { service } = build({ cohortRows: [cohort(4, true, true), cohort(5)] });
        const report = await service.getQualityKpis(FILTERS, { ratingsAuthorized: true, now: NOW });
        expect(report.kpis.rescheduleRate).toMatchObject({ numerator: 0, denominator: 1 });
        expect(report.details.reschedules.rescheduleEventCount).toBe(0);
    });
});
