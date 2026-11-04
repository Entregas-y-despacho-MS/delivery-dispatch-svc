import { describe, expect, it } from 'vitest';
import { InvalidHistoryDateRangeException } from '../../../modules/dispatch/dispatch-history/exceptions/index.js';
import { SlaRangeTooLargeException } from '../exceptions/index.js';
import { SLA_REPORT_MAX_DAYS, assertSlaRange } from './sla-date-range.js';

describe('assertSlaRange', () => {
    it('accepts a single day and an ordinary range', () => {
        expect(() => assertSlaRange('2026-10-19', '2026-10-19')).not.toThrow();
        expect(() => assertSlaRange('2026-10-01', '2026-10-31')).not.toThrow();
    });

    it('rejects a `from` after the `to` with INVALID_DATE_RANGE, the same answer as the history', () => {
        expect(() => assertSlaRange('2026-10-20', '2026-10-19')).toThrow(InvalidHistoryDateRangeException);
        try { assertSlaRange('2026-10-20', '2026-10-19'); } catch (error) {
            expect((error as InvalidHistoryDateRangeException).getResponse()).toMatchObject({ error: 'INVALID_DATE_RANGE' });
        }
    });

    it('accepts exactly 366 days (a leap year, both ends included) and rejects one more', () => {
        expect(SLA_REPORT_MAX_DAYS).toBe(366);
        expect(() => assertSlaRange('2028-01-01', '2028-12-31')).not.toThrow();   // 2028 has 366 days
        expect(() => assertSlaRange('2028-01-01', '2029-01-01')).toThrow(SlaRangeTooLargeException);
        expect(() => assertSlaRange('2026-01-01', '2026-12-31')).not.toThrow();   // 365 days
        expect(() => assertSlaRange('2026-01-01', '2027-01-01')).not.toThrow();   // 366 days
        expect(() => assertSlaRange('2026-01-01', '2027-01-02')).toThrow(SlaRangeTooLargeException);
    });

    it('does not let through something that is not a date (other modules call the service without the DTO)', () => {
        expect(() => assertSlaRange('not-a-date', '2026-10-31')).toThrow(RangeError);
        expect(() => assertSlaRange('2026-10-01', 'tomorrow')).toThrow(RangeError);
        expect(() => assertSlaRange('', '')).toThrow(RangeError);
    });

    it('answers DATE_RANGE_TOO_LARGE with its own code', () => {
        try { assertSlaRange('2020-01-01', '2026-01-01'); expect.unreachable(); } catch (error) {
            expect(error).toBeInstanceOf(SlaRangeTooLargeException);
            expect((error as SlaRangeTooLargeException).getResponse()).toMatchObject({ error: 'DATE_RANGE_TOO_LARGE', message: 'The date range must not exceed 366 days.' });
        }
    });
});
