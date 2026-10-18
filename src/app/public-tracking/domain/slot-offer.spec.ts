import { describe, expect, it } from 'vitest';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import type { OpenBatch } from '../../planning/domain/plan-types.js';
import {
    batchIsOfferable, buildSlotId, chooseOffers, minuteToInstant, offerDateRange, parseSlotId,
    type OfferRules, type RescheduleOffer,
} from './slot-offer.js';

const calendar = { workingWeekdays: new Set([1, 2, 3, 4, 5]), nonWorkingDates: new Set<string>() };

// 2026-10-12 is a Monday. The order was confirmed that day, so D2 is Wednesday the 14th and D3 Thursday the 15th.
function rules(overrides: Partial<OfferRules> = {}): OfferRules {
    return {
        now: localInstant('2026-10-12', '10:00'),
        calendar,
        routeCutoffTime: '15:00',
        minOperatingDays: 2,
        orderConfirmedAt: localInstant('2026-10-12', '09:00'),
        currentShiftDate: '2026-10-15',
        rescheduleWindowDays: 2,
        prepLeadMinutes: 60,
        prepEndTime: '08:15',
        ...overrides,
    };
}

const batch = (shiftDate: string): OpenBatch => ({
    routeBatchId: 1, version: 0, shiftDate, zoneId: 1, zoneCode: 'Z', zoneName: 'Z', warehouseId: 1, vehicleId: 1, stops: [],
});

describe('offerDateRange', () => {
    it('runs from D2 of the order to reschedule_window_days after the current date', () => {
        expect(offerDateRange(rules())).toEqual({ minDate: '2026-10-14', maxDate: '2026-10-17' });
    });

    it('skips the weekend when counting the operating days of the order', () => {
        // Confirmed on a Thursday: D1 Friday, D2 Monday.
        const range = offerDateRange(rules({ orderConfirmedAt: localInstant('2026-10-15', '09:00'), currentShiftDate: '2026-10-19' }));

        expect(range.minDate).toBe('2026-10-19');
    });

    it('widens with a bigger reschedule_window_days', () => {
        expect(offerDateRange(rules({ rescheduleWindowDays: 5 })).maxDate).toBe('2026-10-20');
    });
});

describe('batchIsOfferable', () => {
    const range = { minDate: '2026-10-14', maxDate: '2026-10-17' };

    it('accepts an open batch in range whose cutoff is ahead', () => {
        expect(batchIsOfferable(batch('2026-10-14'), rules(), range)).toBe(true);
    });

    it('rejects a date before D2 and one past the range', () => {
        expect(batchIsOfferable(batch('2026-10-13'), rules(), range)).toBe(false);
        expect(batchIsOfferable(batch('2026-10-18'), rules(), range)).toBe(false);
        expect(batchIsOfferable(batch('2026-10-17'), rules(), range)).toBe(true);
    });

    it('closes at the cutoff of the previous operating day, to the minute', () => {
        // The cutoff of Wednesday the 14th is Tuesday the 13th at 15:00.
        expect(batchIsOfferable(batch('2026-10-14'), rules({ now: new Date(localInstant('2026-10-13', '15:00').getTime() - 1) }), range)).toBe(true);
        expect(batchIsOfferable(batch('2026-10-14'), rules({ now: localInstant('2026-10-13', '15:00') }), range)).toBe(false);
    });

    it('uses the last operating day for the cutoff of a Monday batch', () => {
        // The cutoff of Monday the 19th is Friday the 16th at 15:00, not Sunday.
        const monday = { minDate: '2026-10-14', maxDate: '2026-10-20' };

        expect(batchIsOfferable(batch('2026-10-19'), rules({ now: localInstant('2026-10-16', '14:59') }), monday)).toBe(true);
        expect(batchIsOfferable(batch('2026-10-19'), rules({ now: localInstant('2026-10-16', '15:01') }), monday)).toBe(false);
    });

    it('keeps the lead time the warehouse needs before it finishes on the day of the route', () => {
        // One minute before the cutoff of the 13th (15:00); the warehouse finishes at 08:15 on the 14th: 1036 min later.
        const justBeforeCutoff = localInstant('2026-10-13', '14:59');

        expect(batchIsOfferable(batch('2026-10-14'), rules({ now: justBeforeCutoff, prepLeadMinutes: 1036 }), range)).toBe(true);
        expect(batchIsOfferable(batch('2026-10-14'), rules({ now: justBeforeCutoff, prepLeadMinutes: 1037 }), range)).toBe(false);
    });
});

describe('minuteToInstant', () => {
    it('turns a minute of the local day into an instant', () => {
        expect(minuteToInstant('2026-10-14', 9 * 60)).toEqual(localInstant('2026-10-14', '09:00'));
        expect(minuteToInstant('2026-10-14', 16 * 60 + 30)).toEqual(localInstant('2026-10-14', '16:30'));
    });
});

describe('chooseOffers', () => {
    const offer = (routeBatchId: number, date: string, start: string, costSeconds: number): RescheduleOffer => ({
        routeBatchId, batchVersion: 0, deliveryDate: date,
        windowStart: localInstant(date, start), windowEnd: localInstant(date, `${Number(start.slice(0, 2)) + 2}:00`),
        costSeconds, position: 0, route: [],
    });

    it('keeps one offer per date and time: the cheapest, then the lowest batch id', () => {
        const chosen = chooseOffers([
            offer(9, '2026-10-14', '09:00', 120),
            offer(4, '2026-10-14', '09:00', 60),
            offer(3, '2026-10-14', '09:00', 60),
            offer(2, '2026-10-14', '11:00', 600),
        ]);

        expect(chosen.map((o) => [o.routeBatchId, o.windowStart.toISOString()])).toEqual([
            [3, localInstant('2026-10-14', '09:00').toISOString()],
            [2, localInstant('2026-10-14', '11:00').toISOString()],
        ]);
    });

    it('lists the earliest first across dates', () => {
        const chosen = chooseOffers([
            offer(1, '2026-10-15', '09:00', 0),
            offer(2, '2026-10-14', '14:00', 0),
            offer(3, '2026-10-14', '09:00', 0),
        ]);

        expect(chosen.map((o) => o.routeBatchId)).toEqual([3, 2, 1]);
    });

    it('offers the same time of two different days as two slots', () => {
        expect(chooseOffers([offer(1, '2026-10-14', '09:00', 0), offer(2, '2026-10-15', '09:00', 0)])).toHaveLength(2);
    });

    it('is empty when there is nothing', () => {
        expect(chooseOffers([])).toEqual([]);
    });
});

describe('slot ids', () => {
    it('round-trips a batch and the start of a slot', () => {
        const start = localInstant('2026-10-14', '09:00');

        expect(parseSlotId(buildSlotId(42, start))).toEqual({ routeBatchId: 42, windowStart: start });
    });

    it.each(['', 'abc', '42', '42.', '.1789', '42.17.9', '0.1789000000', '-1.1789', '42.1e9', ' 42.1789 ', '99999999999.1789', '1.1234567890123'])(
        'rejects %j',
        (value) => {
            expect(parseSlotId(value)).toBeNull();
        },
    );
});
