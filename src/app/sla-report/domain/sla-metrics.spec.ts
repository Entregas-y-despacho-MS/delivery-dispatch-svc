import { describe, expect, it } from 'vitest';
import { SlaGroupBy } from './sla-group-by.js';
import { buildSlaReport, isSlaReportOf, round1, toMetrics, type SlaGroupSums } from './sla-metrics.js';

const sums = (overrides: Partial<SlaGroupSums> = {}): SlaGroupSums => ({
    groupId: 1, groupName: 'Zona Norte',
    closedCount: 0, deliveredCount: 0, onTimeCount: 0, lateCount: 0, delayMinutesSum: 0, cycleCount: 0, cycleMinutesSum: 0, incidentCount: 0,
    ...overrides,
});

describe('round1', () => {
    it('keeps one decimal', () => {
        expect(round1(91.666)).toBe(91.7);
        expect(round1(12.04)).toBe(12);
        expect(round1(0.05)).toBe(0.1);
    });
});

describe('toMetrics', () => {
    it('computes the percentage over the delivered ones, not over the closed ones', () => {
        const metrics = toMetrics(sums({ closedCount: 10, deliveredCount: 8, onTimeCount: 6 }));
        expect(metrics.onTimePercentage).toBe(75);
    });

    it('is 0% with nothing delivered (never NaN)', () => {
        const metrics = toMetrics(sums({ closedCount: 3 }));
        expect(metrics.onTimePercentage).toBe(0);
        expect(metrics.closedCount).toBe(3);
    });

    it('averages the delay over the late ones only, and is null when none was late', () => {
        expect(toMetrics(sums({ deliveredCount: 4, lateCount: 2, delayMinutesSum: 50 })).averageDelayMinutes).toBe(25);
        expect(toMetrics(sums({ deliveredCount: 4, onTimeCount: 4 })).averageDelayMinutes).toBeNull();
    });

    it('averages the cycle over the deliveries that have one, and is null when none has', () => {
        expect(toMetrics(sums({ deliveredCount: 3, cycleCount: 2, cycleMinutesSum: 301 })).averageCycleMinutes).toBe(150.5);
        expect(toMetrics(sums({ deliveredCount: 3 })).averageCycleMinutes).toBeNull();
    });

    it('rounds to one decimal', () => {
        expect(toMetrics(sums({ deliveredCount: 3, onTimeCount: 2 })).onTimePercentage).toBe(66.7);
    });
});

describe('buildSlaReport', () => {
    it('totals use the real sums, not the average of the group averages', () => {
        const report = buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.ZONE, [
            // 1 late delivery of 10 minutes, 1 cycle of 100.
            sums({ groupId: 1, groupName: 'A', closedCount: 1, deliveredCount: 1, lateCount: 1, delayMinutesSum: 10, cycleCount: 1, cycleMinutesSum: 100 }),
            // 3 late deliveries of 40 minutes each, 3 cycles of 200.
            sums({ groupId: 2, groupName: 'B', closedCount: 3, deliveredCount: 3, lateCount: 3, delayMinutesSum: 120, cycleCount: 3, cycleMinutesSum: 600 }),
        ]);
        // Average of averages would be (10 + 40) / 2 = 25 and (100 + 200) / 2 = 150.
        expect(report.totals.averageDelayMinutes).toBe(32.5);
        expect(report.totals.averageCycleMinutes).toBe(175);
        expect(report.totals.closedCount).toBe(4);
        expect(report.totals.deliveredCount).toBe(4);
    });

    it('totals of an empty report are zeros and nulls', () => {
        const report = buildSlaReport('2026-10-01', '2026-10-01', SlaGroupBy.DRIVER, []);
        expect(report.rows).toEqual([]);
        expect(report.totals).toEqual({
            closedCount: 0, deliveredCount: 0, onTimeCount: 0, lateCount: 0, onTimePercentage: 0,
            averageDelayMinutes: null, averageCycleMinutes: null, incidentCount: 0,
        });
    });

    it('orders by name ignoring case and accents, the group without a name last, ties by id', () => {
        const report = buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.ZONE, [
            sums({ groupId: null, groupName: null }),
            sums({ groupId: 7, groupName: 'zona sur' }),
            sums({ groupId: 3, groupName: 'Álamos' }),
            sums({ groupId: 9, groupName: 'Zona Sur' }),
            sums({ groupId: 2, groupName: 'Bolognia' }),
        ]);
        expect(report.rows.map((row) => row.groupId)).toEqual([3, 2, 7, 9, null]);
    });

    it('echoes the range and the grouping and carries the id and name of each group', () => {
        const report = buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.SERVICE_LEVEL, [sums({ groupId: 5, groupName: 'Standard', closedCount: 2, deliveredCount: 2, onTimeCount: 2, incidentCount: 4 })]);
        expect(report).toMatchObject({ from: '2026-10-01', to: '2026-10-31', groupBy: 'service_level' });
        expect(report.rows[0]).toMatchObject({ groupId: 5, groupName: 'Standard', onTimePercentage: 100, incidentCount: 4 });
        expect(report.totals.incidentCount).toBe(4);
    });
});

describe('isSlaReportOf', () => {
    const valid = () => buildSlaReport('2026-10-01', '2026-10-31', SlaGroupBy.ZONE, [
        sums({ groupId: 1, closedCount: 5, deliveredCount: 4, onTimeCount: 3, lateCount: 1, delayMinutesSum: 20, cycleCount: 4, cycleMinutesSum: 400, incidentCount: 2 }),
        sums({ groupId: null, groupName: null, closedCount: 1 }),
    ]);
    const check = (value: unknown) => isSlaReportOf(value, '2026-10-01', '2026-10-31', SlaGroupBy.ZONE);

    it('accepts what the service produces (also after a JSON round trip)', () => {
        expect(check(valid())).toBe(true);
        expect(check(JSON.parse(JSON.stringify(valid())))).toBe(true);
    });

    it('rejects a report of another range or another grouping', () => {
        expect(isSlaReportOf(valid(), '2026-10-02', '2026-10-31', SlaGroupBy.ZONE)).toBe(false);
        expect(isSlaReportOf(valid(), '2026-10-01', '2026-10-30', SlaGroupBy.ZONE)).toBe(false);
        expect(isSlaReportOf(valid(), '2026-10-01', '2026-10-31', SlaGroupBy.DRIVER)).toBe(false);
    });

    it('rejects values that are not a report', () => {
        for (const value of [null, undefined, 'x', 7, [], {}, { ...valid(), rows: 'no' }, { ...valid(), totals: null }]) expect(check(value)).toBe(false);
    });

    it('rejects impossible figures', () => {
        const base = valid();
        const withTotals = (changes: object) => ({ ...base, totals: { ...base.totals, ...changes } });
        expect(check(withTotals({ deliveredCount: 99 }))).toBe(false);          // more delivered than closed
        expect(check(withTotals({ onTimeCount: 4, lateCount: 1 }))).toBe(false); // on time + late above delivered
        expect(check(withTotals({ onTimePercentage: 101 }))).toBe(false);
        expect(check(withTotals({ closedCount: -1 }))).toBe(false);
        expect(check(withTotals({ closedCount: 1.5 }))).toBe(false);
        expect(check(withTotals({ averageCycleMinutes: -3 }))).toBe(false);
        expect(check(withTotals({ averageDelayMinutes: null }))).toBe(false);    // something was late, so there is a delay
    });

    it('rejects a row with a wrong id or name', () => {
        const base = valid();
        expect(check({ ...base, rows: [{ ...base.rows[0], groupId: 0 }] })).toBe(false);
        expect(check({ ...base, rows: [{ ...base.rows[0], groupId: '1' }] })).toBe(false);
        expect(check({ ...base, rows: [{ ...base.rows[0], groupName: 5 }] })).toBe(false);
    });
});
