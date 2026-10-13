import { describe, expect, it } from 'vitest';
import {
    evaluateSchedule,
    occurrenceKey,
    parseTimeList,
    toLocalMoment,
    type LocalMoment,
} from './task-schedule.js';

const at = (time: string, date = '2026-10-13'): LocalMoment => {
    const [hours, minutes] = time.split(':').map(Number);
    return { date, time, minuteOfDay: hours * 60 + minutes };
};

describe('toLocalMoment', () => {
    it('converts a UTC instant to America/La_Paz (UTC-4, no daylight saving)', () => {
        expect(toLocalMoment(new Date('2026-10-13T19:00:00.000Z'))).toEqual({
            date: '2026-10-13', time: '15:00', minuteOfDay: 900,
        });
    });

    it('rolls the local date back when UTC is already the next day', () => {
        // 02:30Z of the 14th is 22:30 of the 13th in La Paz.
        expect(toLocalMoment(new Date('2026-10-14T02:30:00.000Z'))).toEqual({
            date: '2026-10-13', time: '22:30', minuteOfDay: 1350,
        });
    });

    it('renders midnight as 00:00, never 24:00', () => {
        expect(toLocalMoment(new Date('2026-10-13T04:00:00.000Z')).time).toBe('00:00');
    });

    it('truncates the seconds: the whole minute is the same moment', () => {
        const start = toLocalMoment(new Date('2026-10-13T12:30:00.000Z'));
        const end = toLocalMoment(new Date('2026-10-13T12:30:59.999Z'));
        expect(end).toEqual(start);
        expect(start.time).toBe('08:30');
    });
});

describe('parseTimeList', () => {
    it('parses a list and trims spaces', () => {
        expect(parseTimeList('08:30, 13:30')).toEqual(['08:30', '13:30']);
    });

    it.each([[''], ['8:30'], ['08:30,'], ['25:00'], ['08:60'], ['08:30;13:30'], ['abc']])(
        'rejects %j', (value) => {
            expect(parseTimeList(value)).toBeNull();
        },
    );

    it('rejects a missing value', () => {
        expect(parseTimeList(null)).toBeNull();
        expect(parseTimeList(undefined)).toBeNull();
    });
});

describe('evaluateSchedule', () => {
    describe('times', () => {
        const schedule = { kind: 'times', settingKey: 'plan_generation_times' } as const;

        it('is due on each listed time and not on others', () => {
            expect(evaluateSchedule(schedule, at('08:30'), '08:30,13:30')).toBe('due');
            expect(evaluateSchedule(schedule, at('13:30'), '08:30,13:30')).toBe('due');
            expect(evaluateSchedule(schedule, at('08:31'), '08:30,13:30')).toBe('not-due');
        });

        it('follows a changed setting on the very next evaluation', () => {
            expect(evaluateSchedule(schedule, at('09:00'), '08:30,13:30')).toBe('not-due');
            expect(evaluateSchedule(schedule, at('09:00'), '09:00')).toBe('due');
        });

        it.each([[null], [''], ['soon']])('is invalid with the value %j (does not run)', (value) => {
            expect(evaluateSchedule(schedule, at('08:30'), value)).toBe('invalid');
        });
    });

    describe('time', () => {
        const schedule = { kind: 'time', settingKey: 'route_cutoff_time' } as const;

        it('is due at the configured time only', () => {
            expect(evaluateSchedule(schedule, at('15:00'), '15:00')).toBe('due');
            expect(evaluateSchedule(schedule, at('15:01'), '15:00')).toBe('not-due');
        });

        it('is invalid when the setting holds a list instead of one time', () => {
            expect(evaluateSchedule(schedule, at('15:00'), '15:00,16:00')).toBe('invalid');
        });

        it('is invalid when the setting is missing', () => {
            expect(evaluateSchedule(schedule, at('15:00'), null)).toBe('invalid');
        });
    });

    describe('every-minutes', () => {
        const schedule = { kind: 'every-minutes', minutes: 15 } as const;

        it('is due on the clock-aligned minutes', () => {
            for (const time of ['00:00', '00:15', '07:30', '23:45']) {
                expect(evaluateSchedule(schedule, at(time), null)).toBe('due');
            }
            for (const time of ['00:01', '07:14', '23:59']) {
                expect(evaluateSchedule(schedule, at(time), null)).toBe('not-due');
            }
        });

        it.each([[0], [-5], [1.5], [1441]])('is invalid for %d minutes', (minutes) => {
            expect(evaluateSchedule({ kind: 'every-minutes', minutes }, at('00:00'), null)).toBe('invalid');
        });
    });
});

describe('occurrenceKey', () => {
    it('is equal for the same task and minute, different otherwise', () => {
        const key = occurrenceKey('route-cutoff', at('15:00'));
        expect(key).toBe('route-cutoff@2026-10-13T15:00');
        expect(occurrenceKey('route-cutoff', at('15:00'))).toBe(key);
        expect(occurrenceKey('route-cutoff', at('15:01'))).not.toBe(key);
        expect(occurrenceKey('route-reminder', at('15:00'))).not.toBe(key);
        expect(occurrenceKey('route-cutoff', at('15:00', '2026-10-14'))).not.toBe(key);
    });
});
