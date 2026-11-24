import { describe, expect, it } from 'vitest';
import type { AttemptEvent } from '../../delivery-promise/domain/first-attempt.js';
import { incidentRateKpi, rescheduleRateKpi, summarizeAttemptQuality, summarizeReschedules, type QualitySource } from './attempt-quality.js';
import { KpiUnavailableReason } from './kpi.js';

let nextId = 1;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, minutes));

function event(status: string, minutes: number, overrides: Partial<AttemptEvent> = {}): AttemptEvent {
    return { eventId: nextId++, clientEventId: null, occurredAt: at(minutes), previousStatus: null, status, countsAsAttempt: false, ...overrides };
}
const source = (dispatchId: number, events: AttemptEvent[]): QualitySource => ({ dispatchId, events });
const incident = (minutes: number, id: string, counts = true) => event('incident', minutes, { clientEventId: id, countsAsAttempt: counts });

describe('summarizeAttemptQuality', () => {
    it('reference case: 4 attempts, 2 with incident → 50 per 100, hand-computed', () => {
        // d1: attempt 1 incident, attempt 2 delivered · d2: delivered · d3: attempt 1 not_delivered + its incident
        const quality = summarizeAttemptQuality([
            source(1, [event('in_transit', 0), incident(5, 'i-1'), event('in_transit', 60), event('delivered', 70)]),
            source(2, [event('in_transit', 0), event('delivered', 10)]),
            source(3, [event('in_transit', 0), event('not_delivered', 10), incident(11, 'i-3')]),
        ]);
        expect(quality).toMatchObject({ attemptCount: 4, attemptsWithIncidentCount: 2, dispatchesWithIncidentCount: 2, incidentEventCount: 2 });
        const kpi = incidentRateKpi(quality, true);
        expect([kpi.numerator, kpi.denominator, kpi.n, kpi.value]).toEqual([2, 4, 4, 50]);
    });

    it('does not double count two incidents of the same attempt', () => {
        const quality = summarizeAttemptQuality([source(1, [event('in_transit', 0), incident(5, 'i-1'), incident(6, 'i-2'), event('not_delivered', 7)])]);
        expect(quality.attemptCount).toBe(1);
        expect(quality.attemptsWithIncidentCount).toBe(1);
        expect(quality.incidentEventCount).toBe(2);
    });

    it('does not double count a repeated incident event (offline retry)', () => {
        const retried = incident(5, 'i-1');
        const quality = summarizeAttemptQuality([source(1, [event('in_transit', 0), retried, { ...retried, eventId: nextId++ }])]);
        expect(quality).toMatchObject({ attemptCount: 1, attemptsWithIncidentCount: 1, incidentEventCount: 1 });
    });

    it('keeps an incident that does not consume an attempt out of the rate and counts it apart', () => {
        const quality = summarizeAttemptQuality([source(1, [event('in_transit', 0), incident(5, 'i-1', false), event('in_transit', 6), event('delivered', 20)])]);
        expect(quality).toMatchObject({ attemptCount: 1, attemptsWithIncidentCount: 0, incidentsWithoutAttemptCount: 1, incidentEventCount: 0 });
    });

    it('leaves a dispatch that cannot be rebuilt out of both sides and counts it', () => {
        const quality = summarizeAttemptQuality([source(1, [incident(5, 'i-1')]), source(2, [event('in_transit', 0), event('delivered', 10)])]);
        expect(quality).toMatchObject({ attemptCount: 1, attemptsWithIncidentCount: 0, notReconstructableCount: 1 });
    });

    it('is Sin datos (available, no value) with no attempts, not a 0', () => {
        const kpi = incidentRateKpi(summarizeAttemptQuality([]), true);
        expect(kpi).toMatchObject({ available: true, value: null, denominator: 0, n: 0 });
    });
});

describe('incidentRateKpi', () => {
    it('is N/D with its cause when the coverage is incomplete, keeping the counts', () => {
        const quality = summarizeAttemptQuality([source(1, [event('in_transit', 0), incident(5, 'i-1')])]);
        const kpi = incidentRateKpi(quality, false);
        expect(kpi).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.ATTEMPT_COVERAGE_INCOMPLETE, numerator: 1, denominator: 1 });
    });
});

describe('summarizeReschedules', () => {
    it('counts unique dispatches, shows the events apart and ignores route reassignments', () => {
        const quality = summarizeReschedules([
            { dispatchId: 1, windowChanged: true }, { dispatchId: 1, windowChanged: true },
            { dispatchId: 2, windowChanged: false }, { dispatchId: 3, windowChanged: true },
        ]);
        expect(quality).toEqual({ rescheduledDispatchCount: 2, rescheduleEventCount: 3, reassignmentOnlyCount: 1 });
    });

    it('the events never raise the denominator: 2 of 8 eligible dispatches = 25', () => {
        const quality = summarizeReschedules([{ dispatchId: 1, windowChanged: true }, { dispatchId: 1, windowChanged: true }, { dispatchId: 2, windowChanged: true }]);
        const kpi = rescheduleRateKpi(quality, 8);
        expect([kpi.numerator, kpi.denominator, kpi.value]).toEqual([2, 8, 25]);
    });

    it('is Sin datos with no eligible dispatch', () => {
        expect(rescheduleRateKpi(summarizeReschedules([]), 0)).toMatchObject({ available: true, value: null });
    });
});
