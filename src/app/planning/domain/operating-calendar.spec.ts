import { describe, expect, it } from 'vitest';
import {
    addDays,
    evaluateCandidateDates,
    firstViableDate,
    fixedDateOfRescheduled,
    isOperatingDay,
    isoWeekday,
    localDate,
    localInstant,
    nextOperatingDay,
    operatingDayAfter,
    previousOperatingDay,
    rescheduledDateProblem,
    viableCandidateDates,
    type OperatingCalendar,
    type PromiseDateRules,
} from './operating-calendar.js';

// 2026-10-12 is a Monday. Local times are America/La_Paz (UTC-4).
const calendar = (nonWorkingDates: string[] = [], weekdays = [1, 2, 3, 4, 5]): OperatingCalendar => ({
    workingWeekdays: new Set(weekdays),
    nonWorkingDates: new Set(nonWorkingDates),
});

const rules: PromiseDateRules = {
    minOperatingDays: 2,
    maxOperatingDays: 3,
    routeCutoffTime: '15:00',
    promiseResponseWindowMinutes: 720,
};

const at = (date: string, time: string): Date => localInstant(date, time);

describe('local dates and instants', () => {
    it('converts a local La Paz date and time to the UTC instant', () => {
        expect(at('2026-10-13', '15:00').toISOString()).toBe('2026-10-13T19:00:00.000Z');
    });

    it('takes the local date of an instant, not the UTC one', () => {
        expect(localDate(new Date('2026-10-13T02:30:00.000Z'))).toBe('2026-10-12');
    });

    it('moves a date across a month end', () => {
        expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    });

    it('numbers the weekday from Monday 1 to Sunday 7', () => {
        expect(isoWeekday('2026-10-12')).toBe(1);
        expect(isoWeekday('2026-10-18')).toBe(7);
    });
});

describe('operating days', () => {
    it('skips the weekend and the listed holidays', () => {
        const cal = calendar(['2026-10-14']);
        expect(isOperatingDay('2026-10-13', cal)).toBe(true);
        expect(isOperatingDay('2026-10-14', cal)).toBe(false);
        expect(isOperatingDay('2026-10-17', cal)).toBe(false);
    });

    it('finds the next and the previous operating day, even from a non operating one', () => {
        const cal = calendar(['2026-10-19']);
        expect(nextOperatingDay('2026-10-16', cal)).toBe('2026-10-20');
        expect(nextOperatingDay('2026-10-17', cal)).toBe('2026-10-20');
        expect(previousOperatingDay('2026-10-20', cal)).toBe('2026-10-16');
    });

    it('counts Dk strictly after D0, which may itself not operate', () => {
        const cal = calendar();
        expect(operatingDayAfter('2026-10-17', 1, cal)).toBe('2026-10-19');
        expect(operatingDayAfter('2026-10-17', 2, cal)).toBe('2026-10-20');
    });

    it('fails instead of looping forever when no weekday operates', () => {
        expect(() => nextOperatingDay('2026-10-12', calendar([], []))).toThrow();
    });
});

describe('first viable date D2-D3 (cutoff 15:00, window 12 h)', () => {
    it('P-101: ordered Monday 08:00, evaluated 08:30 → Wednesday (D2)', () => {
        const result = firstViableDate(at('2026-10-12', '08:00'), at('2026-10-12', '08:30'), calendar(), rules);
        expect(result).toMatchObject({ date: '2026-10-14', operatingDay: 2 });
    });

    it('P-113: ordered Monday 18:30, evaluated Tuesday 08:30 → Thursday (D3), because 08:30 + 12 h passes Tuesday 15:00', () => {
        const order = at('2026-10-12', '18:30');
        const now = at('2026-10-13', '08:30');

        const all = evaluateCandidateDates(order, now, calendar(), rules);
        expect(all.map((c) => [c.operatingDay, c.date, c.viable])).toEqual([
            [2, '2026-10-14', false],
            [3, '2026-10-15', true],
        ]);
        expect(firstViableDate(order, now, calendar(), rules)).toMatchObject({ date: '2026-10-15', operatingDay: 3 });
    });

    it('P-114: ordered Tuesday 08:05, evaluated 08:30 → Thursday (D2)', () => {
        const result = firstViableDate(at('2026-10-13', '08:05'), at('2026-10-13', '08:30'), calendar(), rules);
        expect(result).toMatchObject({ date: '2026-10-15', operatingDay: 2 });
    });

    it('a Friday order is promised Tuesday (D2) and Wednesday (D3), over the weekend', () => {
        const order = at('2026-10-16', '10:00');
        const now = at('2026-10-16', '13:30');
        expect(viableCandidateDates(order, now, calendar(), rules).map((c) => c.date)).toEqual(['2026-10-20', '2026-10-21']);
    });

    it('counts a holiday in the middle as a non operating day', () => {
        // Monday order, Tuesday is a holiday: D1 = Wednesday, D2 = Thursday.
        const cal = calendar(['2026-10-13']);
        const result = firstViableDate(at('2026-10-12', '08:00'), at('2026-10-12', '08:30'), cal, rules);
        expect(result).toMatchObject({ date: '2026-10-15', operatingDay: 2, cutoffDate: '2026-10-14' });
    });

    it('counts from a Saturday order as if it were D0', () => {
        const result = firstViableDate(at('2026-10-17', '10:00'), at('2026-10-17', '10:30'), calendar(), rules);
        expect(result).toMatchObject({ date: '2026-10-20', operatingDay: 2 });
    });

    it('opens an exception, never D4, when neither D2 nor D3 fits', () => {
        const order = at('2026-10-12', '08:00');
        const now = at('2026-10-15', '09:00');

        const all = evaluateCandidateDates(order, now, calendar(), rules);
        expect(all.map((c) => c.operatingDay)).toEqual([2, 3]);
        expect(all.every((c) => !c.viable)).toBe(true);
        expect(firstViableDate(order, now, calendar(), rules)).toBeNull();
    });

    it('is viable exactly at the boundary and not one minute later', () => {
        const order = at('2026-10-12', '08:00');
        // D2 = Wednesday, so D-1 = Tuesday 15:00; 03:00 + 12 h = 15:00.
        expect(firstViableDate(order, at('2026-10-13', '03:00'), calendar(), rules)?.operatingDay).toBe(2);
        expect(firstViableDate(order, at('2026-10-13', '03:01'), calendar(), rules)?.operatingDay).toBe(3);
    });

    it('follows a changed cutoff and a changed window without code changes', () => {
        const order = at('2026-10-12', '08:00');
        const now = at('2026-10-13', '08:30');
        expect(firstViableDate(order, now, calendar(), { ...rules, routeCutoffTime: '22:00' })?.operatingDay).toBe(2);
        expect(firstViableDate(order, now, calendar(), { ...rules, promiseResponseWindowMinutes: 60 })?.operatingDay).toBe(2);
    });

    it('starts at D2: neither D0 nor D1 is ever a candidate', () => {
        const all = evaluateCandidateDates(at('2026-10-12', '08:00'), at('2026-10-12', '08:30'), calendar(), rules);
        expect(all[0].operatingDay).toBe(2);
        expect(all.map((c) => c.date)).not.toContain('2026-10-12');
        expect(all.map((c) => c.date)).not.toContain('2026-10-13');
    });
});

describe('rescheduled dispatches keep their agreed date (D-49)', () => {
    it('uses the last agreed window of the reschedule, even past D3', () => {
        const agreed = at('2026-10-27', '09:00');
        const scheduled = at('2026-10-14', '09:00');
        expect(fixedDateOfRescheduled(agreed, scheduled)).toBe('2026-10-27');
    });

    it('falls back to the scheduled window when there is no reschedule row', () => {
        expect(fixedDateOfRescheduled(null, at('2026-10-14', '09:00'))).toBe('2026-10-14');
        expect(fixedDateOfRescheduled(undefined, null)).toBeNull();
    });

    it('can be planned while the cutoff of its day before has not passed', () => {
        expect(rescheduledDateProblem('2026-10-15', at('2026-10-14', '14:59'), calendar(), '15:00')).toBeNull();
    });

    it('reports a date that is not an operating day', () => {
        expect(rescheduledDateProblem('2026-10-17', at('2026-10-12', '09:00'), calendar(), '15:00')).toBe('not-operating-day');
    });

    it('reports a date whose cutoff already passed', () => {
        expect(rescheduledDateProblem('2026-10-15', at('2026-10-14', '15:00'), calendar(), '15:00')).toBe('cutoff-passed');
    });
});
