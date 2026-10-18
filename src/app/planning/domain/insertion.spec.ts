import { describe, expect, it } from 'vitest';
import { findCheapestInsertion, findInsertionOptions, sequenceByInsertion } from './insertion.js';
import { buildTimeSlots } from './time-slots.js';
import type { SimParams, SimStop, TravelSeconds } from './route-simulation.js';

const hm = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
};

function params(kms: Record<number, number>, over: Partial<SimParams> = {}): SimParams {
    const travelSeconds: TravelSeconds = (from, to) => Math.abs(kms[to] - (from === null ? 0 : kms[from])) * 60;
    return {
        slots: buildTimeSlots({ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }, 120),
        routeStartMinute: hm('09:00'),
        routeEndMinute: hm('18:00'),
        serviceMinutes: 0,
        marginPct: 0,
        travelSeconds,
        ...over,
    };
}

const free = (id: number): SimStop => ({ id, fixedWindow: null });
const notified = (id: number, start: string, end: string): SimStop => ({
    id, fixedWindow: { startMinute: hm(start), endMinute: hm(end) },
});

describe('findCheapestInsertion', () => {
    it('takes the position that adds the least driving time', () => {
        const kms = { 1: 1, 3: 3, 2: 2, 5: 5 };

        // 0 → 1 → 2 → 3 costs nothing extra over 0 → 1 → 3: the point is on the way.
        const between = findCheapestInsertion([free(1), free(3)], free(2), params(kms));
        expect(between).toMatchObject({ position: 1, costSeconds: 0 });

        const after = findCheapestInsertion([free(1), free(3)], free(5), params(kms));
        expect(after).toMatchObject({ position: 2, costSeconds: 2 * 60 });
    });

    it('goes first when the order is empty', () => {
        expect(findCheapestInsertion([], free(1), params({ 1: 4 }))).toMatchObject({ position: 0, costSeconds: 4 * 60 });
    });

    it('breaks a tie with the earliest position', () => {
        // A point at the depot: before the first stop and after it cost the same driving time.
        const choice = findCheapestInsertion([free(1)], free(2), params({ 1: 5, 2: 0 }));

        expect(choice).toMatchObject({ position: 0 });
    });

    it('discards the cheapest position when it would push a notified stop out of its window', () => {
        // N is notified for 09:00-09:20 and is 10 km away: arrival 09:10. X is on the way (5 km), so
        // visiting it first costs no driving time, but its 15 minutes of service push N to 09:25.
        const kms = { 10: 10, 20: 20, 5: 5 };
        const existing = [notified(10, '09:00', '09:20'), free(20)];

        const choice = findCheapestInsertion(existing, free(5), params(kms, { serviceMinutes: 15 }));

        expect(choice?.position).toBe(1);
        expect(choice!.costSeconds).toBeGreaterThan(0);
        // And the notified stop keeps its window in the resulting simulation.
        const notifiedStop = choice!.simulation.stops.find((s) => s.id === 10)!;
        expect(notifiedStop.window).toEqual({ startMinute: hm('09:00'), endMinute: hm('09:20') });
        expect(notifiedStop.arrivalMinute).toBeLessThanOrEqual(hm('09:20'));
    });

    it('returns null when no position keeps the route feasible', () => {
        expect(findCheapestInsertion([free(1)], free(2), params({ 1: 5, 2: 600 }))).toBeNull();
    });

    it('returns null when inserting would make the route end after the afternoon window', () => {
        const kms = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        const existing = [1, 2, 3, 4, 5].map(free);

        expect(findCheapestInsertion(existing, free(6), params(kms, { serviceMinutes: 90 }))).toBeNull();
    });
});

describe('sequenceByInsertion', () => {
    it('builds the visiting order stop by stop and reports the ones that fit nowhere', () => {
        const kms = { 1: 4, 2: 1, 3: 3, 4: 600 };

        const result = sequenceByInsertion([free(1), free(2), free(3), free(4)], params(kms));

        expect(result.sequence.map((s) => s.id)).toEqual([2, 3, 1]);
        expect(result.rejected.map((s) => s.id)).toEqual([4]);
        expect(result.simulation.feasible).toBe(true);
    });

    it('places the stops with a fixed window first when they are offered first', () => {
        const kms = { 1: 30, 2: 5 };

        const result = sequenceByInsertion([notified(1, '09:00', '09:40'), free(2)], params(kms));

        expect(result.sequence.map((s) => s.id)).toEqual([2, 1]);
        expect(result.simulation.stops[1].window.endMinute).toBe(hm('09:40'));
    });
});

describe('findInsertionOptions', () => {
    // Every point is 1 km from the previous one (60 s), 15 minutes of service and no margin: easy to follow by hand.
    const line = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9 };
    const slow = (over: Partial<SimParams> = {}) => params(line, { serviceMinutes: 15, ...over });

    it('offers every slot the stop can get, one per slot, with the cheapest position of each', () => {
        // Eight free stops fill the morning: the ninth point is reached late in the morning or in the afternoon.
        const route = [1, 2, 3, 4, 5, 6, 7, 8].map(free);

        const options = findInsertionOptions(route, free(9), slow());

        expect(options.length).toBeGreaterThan(1);
        const starts = options.map((o) => o.window.startMinute);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        expect(new Set(options.map((o) => `${o.window.startMinute}-${o.window.endMinute}`)).size).toBe(options.length);
        for (const option of options) {
            expect(option.simulation.feasible).toBe(true);
            expect(option.simulation.stops.find((s) => s.id === 9)!.window).toEqual(option.window);
        }
    });

    it('agrees with findCheapestInsertion on the cheapest position overall', () => {
        const route = [free(1), free(3)];

        const cheapest = findCheapestInsertion(route, free(2), params(line));
        const options = findInsertionOptions(route, free(2), params(line));

        const best = [...options].sort((a, b) => a.costSeconds - b.costSeconds || a.position - b.position)[0];
        expect(best).toMatchObject({ position: cheapest!.position, costSeconds: cheapest!.costSeconds });
    });

    it('never offers a position that pushes a notified stop out of its window', () => {
        // The notified stop is told 09:00-11:00 and sits 1 km away. Seven free stops before it would make it late.
        const route = [notified(1, '09:00', '11:00')];

        const options = findInsertionOptions(route, free(2), slow());

        for (const option of options) {
            const stop = option.simulation.stops.find((s) => s.id === 1)!;
            expect(stop.window).toEqual({ startMinute: hm('09:00'), endMinute: hm('11:00') });
            expect(stop.arrivalMinute).toBeLessThanOrEqual(hm('11:00'));
        }
    });

    it('is empty when no position keeps the route feasible', () => {
        // The last notified window ends before anything can reach it behind a long route.
        const route = [notified(1, '09:00', '09:30')];
        const tooLate = params({ 1: 1, 2: 600 }, { serviceMinutes: 15 });

        expect(findInsertionOptions(route, notified(2, '09:00', '09:30'), tooLate)).toEqual([]);
    });

    it('is a single option on an empty route', () => {
        const options = findInsertionOptions([], free(1), params(line));

        expect(options).toHaveLength(1);
        expect(options[0]).toMatchObject({ position: 0, window: { startMinute: hm('09:00'), endMinute: hm('11:00') } });
    });

    it('keeps the earliest of two equally cheap positions for the same slot', () => {
        // Two points at the same place: inserting before or after the twin costs the same.
        const options = findInsertionOptions([free(1)], free(2), params({ 1: 1, 2: 1 }));

        expect(options).toHaveLength(1);
        expect(options[0].position).toBe(0);
    });
});
