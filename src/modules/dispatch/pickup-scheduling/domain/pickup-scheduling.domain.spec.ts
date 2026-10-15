import { describe, expect, it } from 'vitest';
import { checkPickupCapacity } from './pickup-capacity.js';
import { nextPickupRecordVersion } from './pickup-record-version.js';
import { intersectPickupWindows, isWithinAnySlot, isWithinRescheduleLimit } from './pickup-window.js';

// America/La_Paz is UTC-4 all year: 08:00 local = 12:00Z.
const utc = (value: string): Date => new Date(value);
const range = (startsAt: string, endsAt: string) => ({ startsAt: utc(startsAt), endsAt: utc(endsAt) });
const iso = (slots: { startsAt: Date; endsAt: Date }[]) =>
    slots.map((slot) => [slot.startsAt.toISOString(), slot.endsAt.toISOString()]);

describe('intersectPickupWindows', () => {
    const reception = { start: '08:00:00', end: '12:00:00' }; // 12:00Z - 16:00Z

    it('returns the overlap when the supplier range sits inside the reception hours', () => {
        const slots = intersectPickupWindows(range('2026-10-20T13:00:00Z', '2026-10-20T15:00:00Z'), reception);
        expect(iso(slots)).toEqual([['2026-10-20T13:00:00.000Z', '2026-10-20T15:00:00.000Z']]);
    });

    it('cuts the supplier range to the reception hours when they only partly overlap', () => {
        const slots = intersectPickupWindows(range('2026-10-20T14:00:00Z', '2026-10-20T20:00:00Z'), reception);
        expect(iso(slots)).toEqual([['2026-10-20T14:00:00.000Z', '2026-10-20T16:00:00.000Z']]);
    });

    it('returns one slot per day when the supplier range spans several days', () => {
        const slots = intersectPickupWindows(range('2026-10-20T14:00:00Z', '2026-10-21T13:00:00Z'), reception);
        expect(iso(slots)).toEqual([
            ['2026-10-20T14:00:00.000Z', '2026-10-20T16:00:00.000Z'],
            ['2026-10-21T12:00:00.000Z', '2026-10-21T13:00:00.000Z'],
        ]);
    });

    it('returns nothing when the supplier range is outside the reception hours', () => {
        const slots = intersectPickupWindows(range('2026-10-20T17:00:00Z', '2026-10-20T21:00:00Z'), reception);
        expect(slots).toEqual([]);
    });

    it('returns nothing when the ranges only touch at an end point', () => {
        const slots = intersectPickupWindows(range('2026-10-20T16:00:00Z', '2026-10-20T18:00:00Z'), reception);
        expect(slots).toEqual([]);
    });

    it('returns nothing for an empty or inverted supplier range or reception hours', () => {
        expect(intersectPickupWindows(range('2026-10-20T14:00:00Z', '2026-10-20T14:00:00Z'), reception)).toEqual([]);
        expect(
            intersectPickupWindows(range('2026-10-20T13:00:00Z', '2026-10-20T15:00:00Z'), { start: '12:00', end: '08:00' }),
        ).toEqual([]);
    });

    it('uses the local calendar day: 22:00 local is already the next UTC day', () => {
        // 21:00 local on the 20th = 01:00Z on the 21st; the reception day is the local one.
        const slots = intersectPickupWindows(range('2026-10-21T01:00:00Z', '2026-10-21T03:00:00Z'), {
            start: '20:00',
            end: '23:00',
        });
        expect(iso(slots)).toEqual([['2026-10-21T01:00:00.000Z', '2026-10-21T03:00:00.000Z']]);
    });
});

describe('isWithinAnySlot', () => {
    const slots = [range('2026-10-20T14:00:00Z', '2026-10-20T16:00:00Z')];

    it('accepts a range inside a slot, including its borders', () => {
        expect(isWithinAnySlot(range('2026-10-20T14:00:00Z', '2026-10-20T16:00:00Z'), slots)).toBe(true);
        expect(isWithinAnySlot(range('2026-10-20T14:30:00Z', '2026-10-20T15:00:00Z'), slots)).toBe(true);
    });

    it('rejects a range that goes past the slot or is empty', () => {
        expect(isWithinAnySlot(range('2026-10-20T15:00:00Z', '2026-10-20T17:00:00Z'), slots)).toBe(false);
        expect(isWithinAnySlot(range('2026-10-20T15:00:00Z', '2026-10-20T15:00:00Z'), slots)).toBe(false);
    });
});

describe('checkPickupCapacity', () => {
    const vehicle = { capacityKg: 1000, capacityM3: 8 };

    it('fits when weight and volume are within the vehicle capacity', () => {
        const report = checkPickupCapacity({ estimatedWeightKg: 1000, estimatedVolumeM3: 8 }, vehicle);
        expect(report.fits).toBe(true);
    });

    it('does not fit when the weight exceeds the capacity', () => {
        const report = checkPickupCapacity({ estimatedWeightKg: 1200.5, estimatedVolumeM3: 2 }, vehicle);
        expect(report.fits).toBe(false);
        expect(report.weight?.excess).toBe(200.5);
        expect(report.volume?.excess).toBe(0);
    });

    it('does not fit when the volume exceeds the capacity', () => {
        const report = checkPickupCapacity({ estimatedWeightKg: 10, estimatedVolumeM3: 8.5 }, vehicle);
        expect(report.fits).toBe(false);
        expect(report.volume?.excess).toBe(0.5);
    });

    it('does not compare an estimate that Compras did not send', () => {
        const report = checkPickupCapacity({ estimatedWeightKg: null, estimatedVolumeM3: null }, vehicle);
        expect(report).toEqual({ fits: true, weight: null, volume: null });
    });
});

describe('nextPickupRecordVersion', () => {
    it('starts at 1 and then increments the highest published version', () => {
        expect(nextPickupRecordVersion([])).toBe(1);
        expect(nextPickupRecordVersion([1])).toBe(2);
        expect(nextPickupRecordVersion([1, 3, 2])).toBe(4);
    });
});

describe('isWithinRescheduleLimit', () => {
    const current = utc('2026-10-20T14:00:00Z');

    it('accepts a later start within the allowed days', () => {
        expect(isWithinRescheduleLimit(current, utc('2026-10-20T18:00:00Z'), 2)).toBe(true);
        expect(isWithinRescheduleLimit(current, utc('2026-10-22T14:00:00Z'), 2)).toBe(true);
    });

    it('rejects a start beyond the allowed days', () => {
        expect(isWithinRescheduleLimit(current, utc('2026-10-23T14:00:00Z'), 2)).toBe(false);
    });

    it('rejects a start that is not later than the current one', () => {
        expect(isWithinRescheduleLimit(current, current, 2)).toBe(false);
        expect(isWithinRescheduleLimit(current, utc('2026-10-19T14:00:00Z'), 2)).toBe(false);
    });
});
