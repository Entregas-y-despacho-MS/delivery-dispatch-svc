import { describe, expect, it } from 'vitest';
import { InvalidComplaintDateRangeException } from '../exceptions/index.js';
import { buildComplaintCasesQuery } from './complaint-cases-query.js';

describe('buildComplaintCasesQuery', () => {
    it('without filters, has no WHERE and binds nothing', () => {
        const { whereSql, args } = buildComplaintCasesQuery({});

        expect(whereSql).toBe('');
        expect(args).toEqual([]);
    });

    it('combines every filter and binds each value instead of writing it into the SQL', () => {
        const { whereSql, args } = buildComplaintCasesQuery({
            from: '2026-11-01', to: '2026-11-30', zoneId: 3, reasonCode: 'DAMAGED_ITEM', status: 'assigned', assignedUserId: 7,
        });

        expect(args).toEqual(['2026-11-01', '2026-11-30', 3, 'damaged_item', 'assigned', 7]);
        expect(whereSql).toContain("c.consumed_at >= ($1::date)::timestamp AT TIME ZONE 'America/La_Paz'");
        expect(whereSql).toContain("c.consumed_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/La_Paz')");
        expect(whereSql).toContain('d.delivery_zone_id = $3');
        expect(whereSql).toContain('LOWER(c.reason_code) = $4');
        expect(whereSql).toContain('c.investigation_status = $5');
        expect(whereSql).toContain('c.assigned_user_id = $6');
        expect(whereSql).not.toContain('damaged_item');
        expect(whereSql).not.toContain('2026-11-01');
    });

    it('accepts a one-day range and a range with only one end', () => {
        expect(() => buildComplaintCasesQuery({ from: '2026-11-05', to: '2026-11-05' })).not.toThrow();
        expect(() => buildComplaintCasesQuery({ from: '2026-11-05' })).not.toThrow();
        expect(() => buildComplaintCasesQuery({ to: '2026-11-05' })).not.toThrow();
    });

    it('rejects a range whose start is after its end', () => {
        expect(() => buildComplaintCasesQuery({ from: '2026-11-06', to: '2026-11-05' })).toThrow(InvalidComplaintDateRangeException);
    });

    it('a zone or user filter of 0 is still applied, not skipped', () => {
        const { whereSql, args } = buildComplaintCasesQuery({ zoneId: 0 });

        expect(whereSql).toContain('d.delivery_zone_id = $1');
        expect(args).toEqual([0]);
    });
});
