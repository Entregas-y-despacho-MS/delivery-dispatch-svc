import { describe, expect, it } from 'vitest';
import {
    AttemptOutcome, FirstAttemptResult, attemptCoverage, buildFirstAttempt, classifyFirstAttempt, normalizeAttempts, summarizeAttempts, tallyFirstAttempts, unavailableFirstAttempt,
    type AttemptEvent,
} from './first-attempt.js';

let nextId = 1;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, minutes));

function event(status: string, minutes: number, overrides: Partial<AttemptEvent> = {}): AttemptEvent {
    return { eventId: nextId++, clientEventId: null, occurredAt: at(minutes), previousStatus: null, status, countsAsAttempt: false, ...overrides };
}

describe('normalizeAttempts', () => {
    it('is one attempt per trip that ends in a result', () => {
        const history = normalizeAttempts([event('in_transit', 0), event('not_delivered', 10), event('in_transit', 60), event('delivered', 70)]);
        expect(history.reconstructable).toBe(true);
        expect(history.attempts.map((a) => [a.order, a.outcome])).toEqual([[1, AttemptOutcome.NOT_DELIVERED], [2, AttemptOutcome.DELIVERED]]);
    });

    it('counts a repeated event once', () => {
        const delivered = event('delivered', 10, { clientEventId: 'c-1' });
        const history = normalizeAttempts([event('in_transit', 0), delivered, { ...delivered, eventId: nextId++ }, event('delivered', 11, { previousStatus: 'delivered' })]);
        expect(history.attempts).toHaveLength(1);
        expect(history.attempts[0]).toMatchObject({ attemptId: 'c-1', order: 1 });
    });

    it('counts a not_delivered and the incident that caused it as one attempt', () => {
        const history = normalizeAttempts([event('in_transit', 0), event('not_delivered', 10), event('incident', 11, { countsAsAttempt: true, clientEventId: 'i-1' })]);
        expect(history.attempts).toHaveLength(1);
        expect(history.attempts[0].outcome).toBe(AttemptOutcome.NOT_DELIVERED);
    });

    it('counts an incident that consumes an attempt, and ignores one that does not', () => {
        const counts = normalizeAttempts([event('in_transit', 0), event('incident', 5, { countsAsAttempt: true })]);
        expect(counts.attempts.map((a) => a.outcome)).toEqual([AttemptOutcome.INCIDENT]);
        const free = normalizeAttempts([event('in_transit', 0), event('incident', 5, { countsAsAttempt: false })]);
        expect(free.attempts).toEqual([]);
        expect(free.reconstructable).toBe(true);
    });

    it('orders by time and breaks ties by event id', () => {
        const delivered = event('delivered', 10);
        const transit = event('in_transit', 10);
        transit.eventId = delivered.eventId - 1;
        expect(normalizeAttempts([delivered, transit]).attempts).toHaveLength(1);
    });

    it('has no attempt for a dispatch that has not been on a trip yet', () => {
        expect(normalizeAttempts([event('assigned', 0), event('out_for_delivery', 5)])).toEqual({ attempts: [], reconstructable: true });
        expect(normalizeAttempts([])).toEqual({ attempts: [], reconstructable: true });
    });

    it('is not reconstructable when the first result has no trip before it', () => {
        expect(normalizeAttempts([event('delivered', 10)])).toEqual({ attempts: [], reconstructable: false });
    });

    it('skips events with no status', () => {
        expect(normalizeAttempts([event('in_transit', 0), { ...event('x', 1), status: null }, event('delivered', 2)]).attempts).toHaveLength(1);
    });
});

describe('classifyFirstAttempt', () => {
    const window = { start: at(0), end: at(60) };
    const delivered = (minutes: number) => normalizeAttempts([event('in_transit', 0), event('delivered', minutes)]);

    it('tells on time (both ends included), late, failed and not yet apart', () => {
        expect(classifyFirstAttempt(delivered(60), window)).toBe(FirstAttemptResult.ON_TIME);
        expect(classifyFirstAttempt(delivered(61), window)).toBe(FirstAttemptResult.LATE);
        expect(classifyFirstAttempt(normalizeAttempts([event('in_transit', 0), event('not_delivered', 5)]), window)).toBe(FirstAttemptResult.FAILED);
        expect(classifyFirstAttempt(normalizeAttempts([event('assigned', 0)]), window)).toBe(FirstAttemptResult.NO_ATTEMPT_YET);
        expect(classifyFirstAttempt(normalizeAttempts([event('delivered', 5)]), window)).toBe(FirstAttemptResult.NOT_RECONSTRUCTABLE);
    });

    it('judges only the first attempt: a delivery on the second one does not rescue it', () => {
        const history = normalizeAttempts([event('in_transit', 0), event('not_delivered', 5), event('in_transit', 10), event('delivered', 20)]);
        expect(classifyFirstAttempt(history, window)).toBe(FirstAttemptResult.FAILED);
    });

    it('does not call late a delivery that has no valid window', () => {
        expect(classifyFirstAttempt(delivered(10), { start: null, end: null })).toBe(FirstAttemptResult.DELIVERED_NO_WINDOW);
        expect(classifyFirstAttempt(delivered(10), { start: at(60), end: at(0) })).toBe(FirstAttemptResult.DELIVERED_NO_WINDOW);
    });
});

describe('summarizeAttempts', () => {
    const window = { start: at(0), end: at(60) };

    it('gives the valid attempts used and how the first one went', () => {
        const events = [event('in_transit', 0), event('not_delivered', 5), event('in_transit', 10), event('delivered', 20)];
        expect(summarizeAttempts(events, window)).toEqual({ attemptsUsed: 2, firstAttemptResult: FirstAttemptResult.FAILED });
    });

    it('has used none when nothing happened yet', () => {
        expect(summarizeAttempts([], window)).toEqual({ attemptsUsed: 0, firstAttemptResult: FirstAttemptResult.NO_ATTEMPT_YET });
    });

    it('does not know how many it used when the history cannot be rebuilt', () => {
        expect(summarizeAttempts([event('delivered', 5)], window)).toEqual({ attemptsUsed: null, firstAttemptResult: FirstAttemptResult.NOT_RECONSTRUCTABLE });
    });
});

describe('attemptCoverage', () => {
    it('is complete only when the range starts on or after the first instrumented event', () => {
        expect(attemptCoverage(at(10), at(10)).complete).toBe(true);
        expect(attemptCoverage(at(9), at(10)).complete).toBe(false);
        expect(attemptCoverage(at(10), null)).toEqual({ from: null, complete: false });
    });
});

describe('buildFirstAttempt', () => {
    const covered = { from: at(0), complete: true };

    it('is delivered over the first attempts that happened, with late shown apart', () => {
        const counts = tallyFirstAttempts([
            ...Array(6).fill(FirstAttemptResult.ON_TIME), ...Array(2).fill(FirstAttemptResult.LATE), FirstAttemptResult.DELIVERED_NO_WINDOW,
            ...Array(3).fill(FirstAttemptResult.FAILED), ...Array(4).fill(FirstAttemptResult.NO_ATTEMPT_YET), FirstAttemptResult.NOT_RECONSTRUCTABLE,
        ]);
        expect(buildFirstAttempt(counts, covered)).toMatchObject({
            available: true, reason: null, numerator: 9, denominator: 12, n: 12, percentage: 75,
            dateBasis: 'promise_window_end', onTimeCount: 6, lateCount: 2, deliveredWithoutWindowCount: 1, failedCount: 3, noAttemptYetCount: 4, notReconstructableCount: 1,
        });
    });

    it('is Sin datos (available, null) when no first attempt happened, never 0', () => {
        const block = buildFirstAttempt(tallyFirstAttempts([FirstAttemptResult.NO_ATTEMPT_YET]), covered);
        expect(block).toMatchObject({ available: true, denominator: 0, percentage: null, noAttemptYetCount: 1 });
    });

    it('is 0 only when there are first attempts and none delivered', () => {
        expect(buildFirstAttempt(tallyFirstAttempts([FirstAttemptResult.FAILED]), covered).percentage).toBe(0);
    });

    it('is N/D with the reason when the coverage is incomplete, keeping the counts', () => {
        const block = buildFirstAttempt(tallyFirstAttempts([FirstAttemptResult.ON_TIME]), { from: at(0), complete: false });
        expect(block).toMatchObject({ available: false, reason: 'attempt_coverage_incomplete', percentage: null, onTimeCount: 1, coverage: { from: at(0).toISOString(), complete: false } });
    });

    it('is N/D with no counts while the attempts were not read', () => {
        expect(unavailableFirstAttempt()).toMatchObject({ available: false, reason: 'attempt_not_normalized', percentage: null, denominator: 0, coverage: { from: null, complete: false } });
    });
});
