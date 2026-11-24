import { describe, expect, it, vi } from 'vitest';
import { QualityRepository } from './quality.repository.js';

function build(rows: unknown[] = []) {
    const dataSource = { query: vi.fn().mockResolvedValue(rows) };
    return { repository: new QualityRepository(dataSource as any), query: dataSource.query };
}

describe('QualityRepository', () => {
    it('reads the promise cohort with the five filters and one row per reschedule (a route-only row is not a window change in SQL)', async () => {
        const { repository, query } = build([{ dispatch_id: 1, cancelled: false, window_changed: true }, { dispatch_id: 2, cancelled: true, window_changed: null }]);
        const rows = await repository.listPromiseCohort({ from: '2026-11-01', to: '2026-11-30', zoneId: 3, status: 'delivered' });
        expect(rows).toEqual([{ dispatchId: 1, cancelled: false, windowChanged: true }, { dispatchId: 2, cancelled: true, windowChanged: null }]);
        const [sql, params] = query.mock.calls[0];
        expect(params).toEqual(['2026-11-01', '2026-11-30', 3, null, 'delivered']);
        expect(sql).toContain('IS DISTINCT FROM');
        expect(sql).toContain("t.name = 'delivery'");
    });

    it('reads the delivered cohort by closing time, not by promise', async () => {
        const { repository, query } = build([{ dispatch_id: 9, rescheduled: false }]);
        expect(await repository.listDeliveredCohort({ from: '2026-11-01', to: '2026-11-30' })).toEqual([{ dispatchId: 9, rescheduled: false }]);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('d.closed_at >=');
        expect(sql).toContain("s.name = 'delivered'");
        expect(params).toEqual(['2026-11-01', '2026-11-30', null, null, null]);
    });

    it('does not query for an empty list of dispatches', async () => {
        const { repository, query } = build();
        expect(await repository.listComplaintCases([])).toEqual([]);
        expect(await repository.listRatingScores([])).toEqual([]);
        expect((await repository.listIncidentIdsByReason(1, [])).size).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });

    it('maps the cases, the scores and the incident ids', async () => {
        const opened = new Date('2026-11-20T10:00:00Z');
        const cases = build([{ delivery_complaint_case_id: 5, dispatch_id: 1, opened_at: opened, investigation_started_at: null, decided_at: null }]);
        expect(await cases.repository.listComplaintCases([1])).toEqual([{ caseId: 5, dispatchId: 1, openedAt: opened, investigationStartedAt: null, decidedAt: null }]);
        expect(await build([{ score: 5 }, { score: '3' }]).repository.listRatingScores([1])).toEqual([5, 3]);
        const incidents = build([{ id: 'a' }, { id: 'b' }]);
        expect([...(await incidents.repository.listIncidentIdsByReason(7, [1, 2]))]).toEqual(['a', 'b']);
        expect(incidents.query.mock.calls[0][1]).toEqual([7, [1, 2]]);
    });
});
