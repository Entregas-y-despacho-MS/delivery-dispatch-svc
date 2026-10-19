import { describe, expect, it } from 'vitest';
import { DriverMetricsPeriod, resolveMetricsRange } from './metrics-period.js';

// Bolivia is UTC-4 all year: 2026-10-19 is a Monday.
describe('resolveMetricsRange', () => {
    it('today is the Bolivia day, not the UTC one', () => {
        // 23:30 in Bolivia on Monday the 19th is already Tuesday the 20th in UTC.
        const now = new Date('2026-10-20T03:30:00Z');
        expect(resolveMetricsRange(DriverMetricsPeriod.TODAY, now)).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    });

    it('week starts on Monday', () => {
        expect(resolveMetricsRange(DriverMetricsPeriod.WEEK, new Date('2026-10-21T15:00:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-21' });
    });

    it('on a Monday the week is only that day', () => {
        expect(resolveMetricsRange(DriverMetricsPeriod.WEEK, new Date('2026-10-19T15:00:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    });

    it('on a Sunday the week still began on the previous Monday', () => {
        expect(resolveMetricsRange(DriverMetricsPeriod.WEEK, new Date('2026-10-25T15:00:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    });

    it('the week can start in the previous month', () => {
        expect(resolveMetricsRange(DriverMetricsPeriod.WEEK, new Date('2026-11-02T15:00:00Z'))).toEqual({ from: '2026-11-02', to: '2026-11-02' });
        expect(resolveMetricsRange(DriverMetricsPeriod.WEEK, new Date('2026-12-02T15:00:00Z'))).toEqual({ from: '2026-11-30', to: '2026-12-02' });
    });

    it('month runs from the 1st to today', () => {
        expect(resolveMetricsRange(DriverMetricsPeriod.MONTH, new Date('2026-10-19T15:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-19' });
    });

    it('month uses the Bolivia date when UTC is already the next month', () => {
        // 2026-11-01 02:00 UTC is still October 31st, 22:00 in Bolivia.
        expect(resolveMetricsRange(DriverMetricsPeriod.MONTH, new Date('2026-11-01T02:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    });
});
