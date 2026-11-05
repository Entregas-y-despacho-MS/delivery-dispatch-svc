import { describe, expect, it, vi } from 'vitest';
import { SlaGroupBy } from '../domain/sla-group-by.js';
import { SLA_CLOSED_STATUSES, SLA_REPORT_SQL, SlaReportRepository } from './sla-report.repository.js';

const row = (overrides: Record<string, unknown> = {}) => ({
    group_id: 3, group_name: 'Zona Sur', closed_count: 5, delivered_count: 4, on_time_count: 3, late_count: 1,
    delay_minutes_sum: 22.5, cycle_count: 4, cycle_minutes_sum: 480.25, incident_count: 2,
    ...overrides,
});

const build = (rows: unknown[] = []) => {
    const query = vi.fn().mockResolvedValue(rows);
    return { repository: new SlaReportRepository({ query } as never), query };
};

describe('SlaReportRepository.aggregate', () => {
    it('runs the query of the grouping with the two days as bound parameters', async () => {
        const { repository, query } = build();
        await repository.aggregate(SlaGroupBy.ZONE, '2026-10-01', '2026-10-31');
        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith(SLA_REPORT_SQL[SlaGroupBy.ZONE], ['2026-10-01', '2026-10-31']);
    });

    it('maps each row to the sums of its group, keeping the group without id or name', async () => {
        const { repository } = build([row(), row({ group_id: null, group_name: null, closed_count: 1, delivered_count: 0, on_time_count: 0, late_count: 0, delay_minutes_sum: 0, cycle_count: 0, cycle_minutes_sum: 0, incident_count: 0 })]);
        expect(await repository.aggregate(SlaGroupBy.DRIVER, '2026-10-01', '2026-10-31')).toEqual([
            { groupId: 3, groupName: 'Zona Sur', closedCount: 5, deliveredCount: 4, onTimeCount: 3, lateCount: 1, delayMinutesSum: 22.5, cycleCount: 4, cycleMinutesSum: 480.25, incidentCount: 2 },
            { groupId: null, groupName: null, closedCount: 1, deliveredCount: 0, onTimeCount: 0, lateCount: 0, delayMinutesSum: 0, cycleCount: 0, cycleMinutesSum: 0, incidentCount: 0 },
        ]);
    });

    it('answers an empty list when nothing closed in the range', async () => {
        const { repository } = build([]);
        expect(await repository.aggregate(SlaGroupBy.SERVICE_LEVEL, '2026-10-01', '2026-10-01')).toEqual([]);
    });

    it('does not run anything for a grouping outside the whitelist', async () => {
        const { repository, query } = build();
        await expect(repository.aggregate('vehicle' as SlaGroupBy, '2026-10-01', '2026-10-31')).rejects.toThrow('Unsupported SLA report grouping: vehicle');
        expect(query).not.toHaveBeenCalled();
    });
});

describe('the SQL of the report', () => {
    it('counts the closed statuses without `cancelled`', () => {
        expect(SLA_CLOSED_STATUSES).toEqual(['delivered', 'not_delivered', 'returned', 'returned_to_warehouse']);
        for (const sql of Object.values(SLA_REPORT_SQL)) {
            expect(sql).toContain("s.name IN ('delivered', 'not_delivered', 'returned', 'returned_to_warehouse')");
            expect(sql).not.toContain("'cancelled'");
        }
    });

    it('only counts delivery dispatches, by closing time in Bolivia days', () => {
        for (const sql of Object.values(SLA_REPORT_SQL)) {
            expect(sql).toContain("t.name = 'delivery'");
            expect(sql).toContain("d.closed_at >= ($1::date)::timestamp AT TIME ZONE 'America/La_Paz'");
            expect(sql).toContain("d.closed_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/La_Paz')");
        }
    });

    it('groups by the zone of the dispatch, the level of the dispatch or the driver of its route', () => {
        expect(SLA_REPORT_SQL[SlaGroupBy.ZONE]).toContain('d.delivery_zone_id AS group_id');
        expect(SLA_REPORT_SQL[SlaGroupBy.ZONE]).toContain('g.name AS group_name');
        expect(SLA_REPORT_SQL[SlaGroupBy.SERVICE_LEVEL]).toContain('d.service_level_id AS group_id');
        expect(SLA_REPORT_SQL[SlaGroupBy.DRIVER]).toContain('rb.driver_id AS group_id');
        expect(SLA_REPORT_SQL[SlaGroupBy.DRIVER]).toContain('g.full_name AS group_name');
    });

    it('keeps the soft-deleted zones, levels and drivers (they are still who made the trip)', () => {
        for (const sql of Object.values(SLA_REPORT_SQL)) expect(sql).not.toContain('deleted_at');
    });

    it('reports only the active service levels, and only in that grouping', () => {
        expect(SLA_REPORT_SQL[SlaGroupBy.SERVICE_LEVEL]).toContain('(d.service_level_id IS NULL OR g.active)');
        expect(SLA_REPORT_SQL[SlaGroupBy.ZONE]).not.toContain('g.active');
        expect(SLA_REPORT_SQL[SlaGroupBy.DRIVER]).not.toContain('g.active');
    });

    it('measures a delay only after the end of the window, and the cycle only from a departure that is not after the delivery', () => {
        for (const sql of Object.values(SLA_REPORT_SQL)) {
            expect(sql).toContain('c.closed_at > c.scheduled_window_end');
            expect(sql).toContain('c.closed_at >= c.departed_at');
            expect(sql).toContain('c.closed_at BETWEEN c.scheduled_window_start AND c.scheduled_window_end');
        }
    });

    it('looks the departure up only for delivered dispatches, in the last `out_for_delivery` event', () => {
        for (const sql of Object.values(SLA_REPORT_SQL)) {
            expect(sql).toContain("e.metadata->>'status' = 'out_for_delivery'");
            expect(sql).toContain("AND s.name = 'delivered'");
            expect(sql).toContain('ORDER BY e.created_at DESC, e.dispatch_event_id DESC');
        }
    });

    it('never puts a value of the request in the text of the query', () => {
        for (const sql of Object.values(SLA_REPORT_SQL)) {
            expect(sql).not.toMatch(/\d{4}-\d{2}-\d{2}/);
            expect(sql.match(/\$\d/g)?.sort()).toEqual(['$1', '$2']);
        }
    });
});
