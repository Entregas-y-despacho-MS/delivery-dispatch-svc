import { describe, expect, it, vi } from 'vitest';
import { ATTEMPT_EVENTS_BY_IDS_SQL, ATTEMPT_EVENTS_SQL, AttemptsRepository, FIRST_INSTRUMENTED_SQL } from './attempts.repository.js';

function repositoryAnswering(rows: unknown[]) {
    const query = vi.fn().mockResolvedValue(rows);
    return { repository: new AttemptsRepository({ query } as never), query };
}

describe('AttemptsRepository.listSources', () => {
    it('sends only the range and the three optional filters, because the query has no cut parameter', async () => {
        const { repository, query } = repositoryAnswering([]);
        await repository.listSources({ from: '2026-11-01', to: '2026-11-30', zoneId: 3 });
        expect(query).toHaveBeenCalledWith(ATTEMPT_EVENTS_SQL, ['2026-11-01', '2026-11-30', 3, null, null]);
        expect(ATTEMPT_EVENTS_SQL).not.toContain('$6');
    });

    it('turns the dates of the row and of its events into Date', async () => {
        const { repository } = repositoryAnswering([
            {
                dispatch_id: 7,
                window_start: '2026-11-10T12:00:00.000Z',
                window_end: '2026-11-10T14:00:00.000Z',
                events: [{ eventId: 1, clientEventId: null, occurredAt: '2026-11-10T12:30:00.000Z', previousStatus: 'out_for_delivery', status: 'in_transit', countsAsAttempt: false }],
            },
        ]);
        const [source] = await repository.listSources({ from: '2026-11-01', to: '2026-11-30' });
        expect(source.dispatchId).toBe(7);
        expect(source.windowEnd).toEqual(new Date('2026-11-10T14:00:00.000Z'));
        expect(source.events[0].occurredAt).toEqual(new Date('2026-11-10T12:30:00.000Z'));
    });

    it('keeps a dispatch without window and without events', async () => {
        const { repository } = repositoryAnswering([{ dispatch_id: 8, window_start: null, window_end: null, events: [] }]);
        expect(await repository.listSources({ from: '2026-11-01', to: '2026-11-30' })).toEqual([{ dispatchId: 8, windowStart: null, windowEnd: null, events: [] }]);
    });

    it('reads both forms of the new status and only delivery dispatches, ordered by time', () => {
        expect(ATTEMPT_EVENTS_SQL).toContain("COALESCE(e.metadata->>'status', e.metadata->>'to')");
        expect(ATTEMPT_EVENTS_SQL).toContain("t.name = 'delivery'");
        expect(ATTEMPT_EVENTS_SQL).toContain('ORDER BY e.created_at, e.dispatch_event_id');
        expect(ATTEMPT_EVENTS_SQL).toContain("IN ('in_transit', 'delivered', 'not_delivered', 'incident')");
    });
});

describe('AttemptsRepository.listSourcesByIds', () => {
    it('asks for the given dispatches and does not touch the database for an empty list', async () => {
        const { repository, query } = repositoryAnswering([{ dispatch_id: 4, window_start: null, window_end: null, events: [] }]);
        expect(await repository.listSourcesByIds([4, 9])).toHaveLength(1);
        expect(query).toHaveBeenCalledWith(ATTEMPT_EVENTS_BY_IDS_SQL, [[4, 9]]);
        query.mockClear();
        expect(await repository.listSourcesByIds([])).toEqual([]);
        expect(query).not.toHaveBeenCalled();
    });
});

describe('AttemptsRepository.findCoverage', () => {
    it('is complete when the range starts on or after the first trip written with its previous status and author', async () => {
        const { repository, query } = repositoryAnswering([{ first_at: '2026-10-05T10:00:00.000Z', range_start: '2026-11-01T04:00:00.000Z' }]);
        expect(await repository.findCoverage('2026-11-01')).toEqual({ from: new Date('2026-10-05T10:00:00.000Z'), complete: true });
        expect(query).toHaveBeenCalledWith(FIRST_INSTRUMENTED_SQL, ['2026-11-01']);
        expect(FIRST_INSTRUMENTED_SQL).toContain("e.metadata->>'previousStatus' IS NOT NULL");
        expect(FIRST_INSTRUMENTED_SQL).toContain('e.actor_type IS NOT NULL');
    });

    it('is incomplete when the range starts before it', async () => {
        const { repository } = repositoryAnswering([{ first_at: '2026-10-05T10:00:00.000Z', range_start: '2026-10-01T04:00:00.000Z' }]);
        expect((await repository.findCoverage('2026-10-01')).complete).toBe(false);
    });

    it('is incomplete with no instrumented trip at all', async () => {
        const { repository } = repositoryAnswering([{ first_at: null, range_start: '2026-11-01T04:00:00.000Z' }]);
        expect(await repository.findCoverage('2026-11-01')).toEqual({ from: null, complete: false });
    });
});
