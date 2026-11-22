import { describe, expect, it, vi } from 'vitest';
import { OTD_COHORT_SQL, OtdRepository } from './otd.repository.js';

const NOW = new Date('2026-11-20T15:00:00Z');

function repositoryAnswering(rows: unknown[]) {
    const query = vi.fn().mockResolvedValue(rows);
    return { repository: new OtdRepository({ query } as never), query };
}

describe('OtdRepository', () => {
    it('sends the range, the three optional filters and the moment of the cut, in that order', async () => {
        const { repository, query } = repositoryAnswering([{}]);
        await repository.countCohort({ from: '2026-11-01', to: '2026-11-30', zoneId: 3, serviceLevelId: 2, status: 'assigned' }, NOW);
        expect(query).toHaveBeenCalledWith(OTD_COHORT_SQL, ['2026-11-01', '2026-11-30', 3, 2, 'assigned', NOW]);
    });

    it('sends NULL for a filter that was not asked', async () => {
        const { repository, query } = repositoryAnswering([{}]);
        await repository.countCohort({ from: '2026-11-01', to: '2026-11-30' }, NOW);
        expect(query.mock.calls[0][1]).toEqual(['2026-11-01', '2026-11-30', null, null, null, NOW]);
    });

    it('maps the counts of the row', async () => {
        const { repository } = repositoryAnswering([
            { eligible: 42, on_time: 35, invalid_window: 1, excluded_cancellations: 3, unreconstructable_cancellations: 2, rescheduled_promise: 4 },
        ]);
        expect(await repository.countCohort({ from: '2026-11-01', to: '2026-11-30' }, NOW)).toEqual({
            eligible: 42,
            onTime: 35,
            invalidWindow: 1,
            excludedCancellations: 3,
            unreconstructableCancellations: 2,
            rescheduledPromise: 4,
        });
    });

    it('answers zeros when the query returns no row', async () => {
        const { repository } = repositoryAnswering([]);
        expect(await repository.countCohort({ from: '2026-11-01', to: '2026-11-30' }, NOW)).toEqual({
            eligible: 0,
            onTime: 0,
            invalidWindow: 0,
            excludedCancellations: 0,
            unreconstructableCancellations: 0,
            rescheduledPromise: 0,
        });
    });

    it('only measures dispatches whose promise already passed, and only the delivery type', () => {
        expect(OTD_COHORT_SQL).toContain('a.anchor < $6::timestamptz');
        expect(OTD_COHORT_SQL).toContain("t.name = 'delivery'");
    });
});
