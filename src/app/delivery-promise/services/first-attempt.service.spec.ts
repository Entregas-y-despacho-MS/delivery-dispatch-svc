import { describe, expect, it, vi } from 'vitest';
import type { AttemptEvent } from '../domain/first-attempt.js';
import { FirstAttemptService } from './first-attempt.service.js';

let nextId = 1;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 12, minutes));
const event = (status: string, minutes: number): AttemptEvent => ({ eventId: nextId++, clientEventId: null, occurredAt: at(minutes), previousStatus: null, status, countsAsAttempt: false });

const WINDOW = { windowStart: at(0), windowEnd: at(60) };
const source = (dispatchId: number, events: AttemptEvent[], window = WINDOW) => ({ dispatchId, ...window, events });
const FILTERS = { from: '2026-11-01', to: '2026-11-30', zoneId: 3 };

function service(sources: ReturnType<typeof source>[], coverage = { from: new Date('2026-10-01T00:00:00Z'), complete: true }) {
    const repository = {
        listSources: vi.fn().mockResolvedValue(sources),
        listSourcesByIds: vi.fn().mockResolvedValue(sources),
        findCoverage: vi.fn().mockResolvedValue(coverage),
    };
    return { service: new FirstAttemptService(repository as never), repository };
}

describe('FirstAttemptService.getFirstAttempt', () => {
    const delivered = (id: number, minutes: number) => source(id, [event('in_transit', 0), event('delivered', minutes)]);

    it('counts each first attempt once and leaves the unmeasurable ones out of the rate', async () => {
        const { service: svc, repository } = service([
            delivered(1, 30),
            delivered(2, 90),
            source(3, [event('in_transit', 0), event('not_delivered', 10), event('in_transit', 20), event('delivered', 30)]),
            source(4, [event('assigned', 0)]),
            source(5, [event('delivered', 10)]),
        ]);
        const block = await svc.getFirstAttempt(FILTERS);
        expect(block).toMatchObject({
            available: true, numerator: 2, denominator: 3, percentage: 66.7,
            onTimeCount: 1, lateCount: 1, failedCount: 1, noAttemptYetCount: 1, notReconstructableCount: 1,
        });
        expect(repository.listSources).toHaveBeenCalledWith(FILTERS);
        expect(repository.findCoverage).toHaveBeenCalledWith('2026-11-01');
    });

    it('is N/D with the counts when the range starts before the instrumented period', async () => {
        const { service: svc } = service([delivered(1, 30)], { from: new Date('2026-11-05T00:00:00Z'), complete: false });
        expect(await svc.getFirstAttempt(FILTERS)).toMatchObject({ available: false, reason: 'attempt_coverage_incomplete', percentage: null, onTimeCount: 1 });
    });

    it('is Sin datos (available, null) when no dispatch is in the range', async () => {
        const { service: svc } = service([]);
        expect(await svc.getFirstAttempt(FILTERS)).toMatchObject({ available: true, denominator: 0, percentage: null });
    });
});

describe('FirstAttemptService.summarize', () => {
    it('gives each dispatch its attempts used and first result', async () => {
        const { service: svc, repository } = service([source(7, [event('in_transit', 0), event('not_delivered', 5)]), source(8, [])]);
        const summary = await svc.summarize([7, 8]);
        expect(repository.listSourcesByIds).toHaveBeenCalledWith([7, 8]);
        expect(summary.get(7)).toEqual({ attemptsUsed: 1, firstAttemptResult: 'failed' });
        expect(summary.get(8)).toEqual({ attemptsUsed: 0, firstAttemptResult: 'no_attempt_yet' });
    });
});
