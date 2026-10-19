import { describe, expect, it } from 'vitest';
import { buildHistoryQuery } from './history-query.js';
import { DispatchHistorySortBy } from '../dto/find-dispatch-history-params.dto.js';
import { DispatchStatusEnum } from '../../../../shared/enums/dispatch-status.enum.js';
import { InvalidHistoryDateRangeException } from '../exceptions/index.js';

describe('buildHistoryQuery', () => {
    it('without filters, lists only terminal statuses with a closing time, most recent first', () => {
        const { whereSql, orderSql, args } = buildHistoryQuery({});

        expect(whereSql).toContain("s.name IN ('delivered', 'not_delivered', 'returned', 'returned_to_warehouse', 'cancelled')");
        expect(whereSql).toContain('d.closed_at IS NOT NULL');
        expect(orderSql).toBe('ORDER BY d.closed_at DESC, d.dispatch_id DESC');
        expect(args).toEqual([]);
    });

    it('combines every filter and binds each value instead of writing it into the SQL', () => {
        const { whereSql, args } = buildHistoryQuery({
            from: '2026-10-01', to: '2026-10-31', driverId: 7, plate: '1234ABC', status: DispatchStatusEnum.DELIVERED, search: 'DSP-2026',
        });

        expect(args).toEqual(['2026-10-01', '2026-10-31', 7, '%1234ABC%', 'delivered', '%DSP-2026%']);
        expect(whereSql).toContain("d.closed_at >= ($1::date)::timestamp AT TIME ZONE 'America/La_Paz'");
        expect(whereSql).toContain("d.closed_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/La_Paz')");
        expect(whereSql).toContain('rb.driver_id = $3');
        expect(whereSql).toContain('v.plate ILIKE $4');
        expect(whereSql).toContain('s.name = $5');
        expect(whereSql).toContain('d.tracking_code ILIKE $6');
        expect(whereSql).not.toContain('1234ABC');
        expect(whereSql).not.toContain('2026-10-01');
    });

    it('matches % and _ of the search literally', () => {
        const { args } = buildHistoryQuery({ search: '50%_a', plate: 'A_B' });

        expect(args).toEqual(['%A\\_B%', '%50\\%\\_a%']);
    });

    it('accepts a range of a single day and a range with only one end', () => {
        expect(() => buildHistoryQuery({ from: '2026-10-05', to: '2026-10-05' })).not.toThrow();
        expect(buildHistoryQuery({ from: '2026-10-05' }).args).toEqual(['2026-10-05']);
        expect(buildHistoryQuery({ to: '2026-10-05' }).args).toEqual(['2026-10-05']);
    });

    it('rejects a range whose start is after its end', () => {
        expect(() => buildHistoryQuery({ from: '2026-10-06', to: '2026-10-05' })).toThrow(InvalidHistoryDateRangeException);
    });

    it('sorts only by whitelisted columns, with the id as tie-breaker', () => {
        const byDriver = buildHistoryQuery({ sortBy: DispatchHistorySortBy.DRIVER, order: 'asc' }).orderSql;
        const byPlate = buildHistoryQuery({ sortBy: DispatchHistorySortBy.PLATE }).orderSql;
        const oldestFirst = buildHistoryQuery({ order: 'asc' }).orderSql;

        expect(byDriver).toBe('ORDER BY LOWER(u.full_name) ASC NULLS LAST, d.dispatch_id DESC');
        expect(byPlate).toBe('ORDER BY v.plate DESC NULLS LAST, d.dispatch_id DESC');
        expect(oldestFirst).toBe('ORDER BY d.closed_at ASC, d.dispatch_id ASC');
    });

    it('never writes a sort value that is not in the whitelist into the SQL', () => {
        const hostile = "closedAt; DROP TABLE dispatches" as unknown as DispatchHistorySortBy;

        expect(() => buildHistoryQuery({ sortBy: hostile })).toThrow();
    });
});
