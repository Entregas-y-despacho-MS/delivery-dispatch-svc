import { describe, expect, it } from 'vitest';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import type { SimStopResult } from '../../planning/domain/route-simulation.js';
import { closeGap, layoutDestination } from './reschedule-layout.js';

const DATE = '2026-10-14';
const hm = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const stop = (id: number, start: string, end: string): SimStopResult => ({
    id, arrivalMinute: hm(start), startMinute: hm(start), departureMinute: hm(start) + 15,
    window: { startMinute: hm(start), endMinute: hm(end) }, fixed: false,
});
const at = (time: string) => localInstant(DATE, time);

describe('layoutDestination', () => {
    it('numbers the simulated route from 1 and puts the customer where the simulation put it', () => {
        const route = [stop(20, '09:00', '11:00'), stop(1, '09:00', '11:00'), stop(30, '11:00', '13:00')];
        const current = [
            { dispatchId: 20, sequence: 1, windowStart: at('09:00') },
            { dispatchId: 30, sequence: 2, windowStart: at('11:00') },
        ];

        const layout = layoutDestination(route, 1, DATE, current)!;

        expect(layout.own).toMatchObject({ dispatchId: 1, sequence: 2, windowStart: at('09:00'), windowEnd: at('11:00') });
        expect(layout.others.map((o) => [o.dispatchId, o.sequence])).toEqual([[20, 1], [30, 3]]);
    });

    it('marks as changed only the stops whose place or slot is not what it was', () => {
        const route = [stop(20, '09:00', '11:00'), stop(1, '09:00', '11:00'), stop(30, '11:00', '13:00'), stop(40, '14:00', '16:00')];
        const current = [
            { dispatchId: 20, sequence: 1, windowStart: at('09:00') },
            { dispatchId: 30, sequence: 2, windowStart: at('11:00') },
            { dispatchId: 40, sequence: 3, windowStart: at('14:00') },
        ];

        const layout = layoutDestination(route, 1, DATE, current)!;

        // 20 keeps place and slot; 30 and 40 each moved one place down.
        expect(layout.others.map((o) => [o.dispatchId, o.changed])).toEqual([[20, false], [30, true], [40, true]]);
        expect(layout.own.changed).toBe(true);
    });

    it('treats a stop that gets another slot as changed even if its place is the same', () => {
        const route = [stop(20, '11:00', '13:00'), stop(1, '11:00', '13:00')];
        const current = [{ dispatchId: 20, sequence: 1, windowStart: at('09:00') }];

        expect(layoutDestination(route, 1, DATE, current)!.others[0]).toMatchObject({ sequence: 1, changed: true });
    });

    it('treats a stop that had no number yet as changed', () => {
        const route = [stop(1, '09:00', '11:00'), stop(20, '09:00', '11:00')];
        const current = [{ dispatchId: 20, sequence: null, windowStart: at('09:00') }];

        expect(layoutDestination(route, 1, DATE, current)!.others[0].changed).toBe(true);
    });

    it('is the customer alone in an empty batch', () => {
        const layout = layoutDestination([stop(1, '09:00', '11:00')], 1, DATE, [])!;

        expect(layout.own.sequence).toBe(1);
        expect(layout.others).toEqual([]);
    });

    it.each([
        ['a stop the simulation did not have', [stop(1, '09:00', '11:00')], [{ dispatchId: 99, sequence: 1, windowStart: at('09:00') }]],
        ['a stop the simulation had and the batch lost', [stop(1, '09:00', '11:00'), stop(20, '09:00', '11:00')], []],
        ['a different stop in the same count', [stop(1, '09:00', '11:00'), stop(20, '09:00', '11:00')], [{ dispatchId: 21, sequence: 1, windowStart: at('09:00') }]],
    ])('is stale (null) with %s', (_name, route, current) => {
        expect(layoutDestination(route, 1, DATE, current)).toBeNull();
    });

    it('is stale when the route does not contain the customer', () => {
        expect(layoutDestination([stop(20, '09:00', '11:00')], 1, DATE, [{ dispatchId: 20, sequence: 1, windowStart: at('09:00') }])).toBeNull();
    });
});

describe('closeGap', () => {
    const stops = (...sequences: (number | null)[]) => sequences.map((sequence, i) => ({ dispatchId: 10 + i, sequence, windowStart: null }));

    it('keeps the order and numbers from 1 with no hole', () => {
        const placed = closeGap([
            { dispatchId: 12, sequence: 4, windowStart: null },
            { dispatchId: 10, sequence: 1, windowStart: null },
            { dispatchId: 11, sequence: 3, windowStart: null },
        ]);

        expect(placed).toEqual([
            { dispatchId: 10, sequence: 1, changed: false },
            { dispatchId: 11, sequence: 2, changed: true },
            { dispatchId: 12, sequence: 3, changed: true },
        ]);
    });

    it('changes nothing when the stop that left was the last one', () => {
        expect(closeGap(stops(1, 2, 3)).every((p) => !p.changed)).toBe(true);
    });

    it('is empty for an empty batch', () => {
        expect(closeGap([])).toEqual([]);
    });

    it('puts a stop without a number last, by id', () => {
        const placed = closeGap([
            { dispatchId: 5, sequence: null, windowStart: null },
            { dispatchId: 6, sequence: 1, windowStart: null },
        ]);

        expect(placed.map((p) => p.dispatchId)).toEqual([6, 5]);
    });
});
