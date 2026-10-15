import { describe, expect, it, vi } from 'vitest';
import { PromiseWindowCandidatesRepository } from './promise-window-candidates.repository.js';

describe('PromiseWindowCandidatesRepository', () => {
    it('asks only for open promises with a valid notice and a closed window, oldest first', async () => {
        const dataSource = { query: vi.fn().mockResolvedValue([{ id: 7 }, { id: 9 }]) };
        const repository = new PromiseWindowCandidatesRepository(dataSource as never);
        const now = new Date('2026-10-16T00:00:00.000Z');

        const ids = await repository.findClosable(now, 720, 50);

        expect(ids).toEqual([7, 9]);
        const [sql, params] = dataSource.query.mock.calls[0]!;
        expect(sql).toContain('d.promise_notified_at IS NOT NULL');
        expect(sql).toContain('d.promise_firmed_at IS NULL');
        expect(sql).toContain("d.customer_confirmation = 'pending'");
        expect(sql).toContain('make_interval(mins => $2::int) <= $3');
        expect(sql).toContain('ORDER BY d.promise_notified_at, d.dispatch_id');
        expect(params).toEqual([['scheduled', 'assigned'], 720, now, 50]);
    });
});
