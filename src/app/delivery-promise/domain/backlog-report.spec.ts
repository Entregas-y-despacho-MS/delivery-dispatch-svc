import { describe, expect, it } from 'vitest';
import { AgeRange } from './backlog-buckets.js';
import { buildBacklogReport, type BacklogRow, type OpenOverdueRow } from './backlog-report.js';

const NOW = new Date('2026-11-20T15:00:00Z');
const QUERY = { from: '2026-11-01', to: '2026-11-30' };

const row = (status: string, count: number, overdue = false, ageRange: AgeRange | null = null): BacklogRow => ({ status, overdue, ageRange, count });
const report = (rows: BacklogRow[], list: OpenOverdueRow[] = []) => buildBacklogReport(QUERY, rows, list, 'promise_window_end', NOW);

describe('buildBacklogReport', () => {
    it('puts every dispatch in exactly one bucket and keeps the terminal ones out of the backlog', () => {
        const result = report([
            row('delivered', 10),
            row('not_delivered', 2),
            row('returned', 1),
            row('returned_to_warehouse', 2),
            row('cancelled', 4),
            row('rescheduled', 3),
            row('assigned', 5, true, AgeRange.OVER_3_DAYS),
            row('assigned', 6, false, AgeRange.UNDER_1_DAY),
            row('scheduled', 7, false, AgeRange.ONE_TO_3_DAYS),
        ]);
        expect(result.counts).toEqual({ delivered: 10, openOverdue: 5, pending: 13, notDelivered: 2, rescheduled: 3, cancelled: 4, returned: 3 });
        expect(result.backlogTotal).toBe(18);
        expect(result.empty).toBe(false);
    });

    it('does not count an open overdue dispatch twice: it is not in the pending stages', () => {
        const result = report([row('assigned', 5, true, AgeRange.UNDER_1_DAY)]);
        expect(result.counts.openOverdue).toBe(5);
        expect(result.counts.pending).toBe(0);
        expect(result.pendingByStage).toEqual([]);
        expect(result.openOverdueByAge).toEqual({ under_1d: 5, '1d_to_3d': 0, over_3d: 0 });
    });

    it('groups the pending ones by exclusive stage and age, in the order of the stages, only those that have dispatches', () => {
        const result = report([
            row('scheduled', 2, false, AgeRange.ONE_TO_3_DAYS),
            row('pending', 1, false, AgeRange.UNDER_1_DAY),
            row('scheduled', 3, false, AgeRange.UNDER_1_DAY),
        ]);
        expect(result.pendingByStage).toEqual([
            { stage: 'pending', total: 1, byAge: { under_1d: 1, '1d_to_3d': 0, over_3d: 0 } },
            { stage: 'scheduled', total: 5, byAge: { under_1d: 3, '1d_to_3d': 2, over_3d: 0 } },
        ]);
        expect(result.counts.pending).toBe(result.pendingByStage.reduce((sum, stage) => sum + stage.total, 0));
    });

    it('counts a dispatch delivered inside a batch by its own status', () => {
        expect(report([row('delivered', 1)]).counts.delivered).toBe(1);
    });

    it('lists the open overdue dispatches with their next action', () => {
        const result = report([row('assigned', 1, true, AgeRange.UNDER_1_DAY)], [
            { dispatchId: 7, trackingCode: 'TR-7', status: 'assigned', zoneId: 3, serviceLevelId: null, promiseEnd: new Date('2026-11-19T16:00:00Z'), overdueMinutes: 1380 },
        ]);
        expect(result.openOverdue).toEqual([
            { dispatchId: 7, trackingCode: 'TR-7', status: 'assigned', zoneId: 3, serviceLevelId: null, promiseEnd: '2026-11-19T16:00:00.000Z', overdueMinutes: 1380, nextAction: 'start_route' },
        ]);
    });

    it('says «Sin datos» (empty, all zeros) when the filters leave nothing', () => {
        const result = report([]);
        expect(result.empty).toBe(true);
        expect(result.backlogTotal).toBe(0);
        expect(result.openOverdue).toEqual([]);
    });

    it('repeats the filters, time zone and cut it was computed with', () => {
        const result = buildBacklogReport({ ...QUERY, zoneId: 3 }, [], [], 'promise_window_end', NOW);
        expect(result).toMatchObject({ from: '2026-11-01', to: '2026-11-30', timeZone: 'America/La_Paz', asOf: '2026-11-20T15:00:00.000Z', filters: { zoneId: 3, serviceLevelId: null, status: null } });
    });
});
