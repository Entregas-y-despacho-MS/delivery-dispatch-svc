import { describe, expect, it, vi } from 'vitest';
import { BACKLOG_COUNTS_SQL, BacklogRepository, OPEN_OVERDUE_SQL } from './backlog.repository.js';

const NOW = new Date('2026-11-20T15:00:00Z');

describe('BacklogRepository', () => {
    it('maps the groups of the counts query', async () => {
        const query = vi.fn().mockResolvedValue([{ status: 'assigned', overdue: true, age_range: 'over_3d', count: 4 }, { status: 'delivered', overdue: false, age_range: null, count: 9 }]);
        const repository = new BacklogRepository({ query } as never);
        const rows = await repository.countByStatus({ from: '2026-11-01', to: '2026-11-30', zoneId: 3 }, NOW);
        expect(query).toHaveBeenCalledWith(BACKLOG_COUNTS_SQL, ['2026-11-01', '2026-11-30', 3, null, null, NOW]);
        expect(rows).toEqual([{ status: 'assigned', overdue: true, ageRange: 'over_3d', count: 4 }, { status: 'delivered', overdue: false, ageRange: null, count: 9 }]);
    });

    it('sends the size of the list as the seventh parameter and maps the dispatches', async () => {
        const query = vi.fn().mockResolvedValue([
            { dispatch_id: 7, tracking_code: null, status: 'incident', delivery_zone_id: null, service_level_id: 2, window_end: '2026-11-19T16:00:00.000Z', overdue_minutes: 1380 },
        ]);
        const repository = new BacklogRepository({ query } as never);
        const rows = await repository.listOpenOverdue({ from: '2026-11-01', to: '2026-11-30' }, NOW, 25);
        expect(query).toHaveBeenCalledWith(OPEN_OVERDUE_SQL, ['2026-11-01', '2026-11-30', null, null, null, NOW, 25]);
        expect(rows).toEqual([{ dispatchId: 7, trackingCode: null, status: 'incident', zoneId: null, serviceLevelId: 2, promiseEnd: new Date('2026-11-19T16:00:00.000Z'), overdueMinutes: 1380 }]);
    });

    it('orders the list with the most overdue first and caps it', () => {
        expect(OPEN_OVERDUE_SQL).toContain('ORDER BY s.window_end ASC');
        expect(OPEN_OVERDUE_SQL).toContain('LIMIT $7::int');
    });

    it('only counts dispatches of the delivery type, and gives no age range to a finished dispatch', () => {
        expect(BACKLOG_COUNTS_SQL).toContain("t.name = 'delivery'");
        expect(BACKLOG_COUNTS_SQL).toContain('WHEN s.age_minutes IS NULL THEN NULL');
    });

    it('never calls a dispatch overdue by its status alone: it needs an active status and a valid window that ended', () => {
        expect(BACKLOG_COUNTS_SQL).toContain('b.valid_window AND b.window_end < $6::timestamptz');
    });
});
