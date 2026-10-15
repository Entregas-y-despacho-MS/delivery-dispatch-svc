import { describe, expect, it } from 'vitest';
import { buildTimeSlots, slotForArrival } from './time-slots.js';
import {
    drivingSeconds, simulateRoute, type SimParams, type SimStop, type TravelSeconds,
} from './route-simulation.js';

const hm = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
};

const SLOTS = buildTimeSlots({ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }, 120);

/** Stops on a line: 1 km = 1 minute (60 s) of driving. Id 0 is not used; the depot is at km 0. */
function line(kms: Record<number, number>): TravelSeconds {
    return (from, to) => {
        const a = from === null ? 0 : kms[from];
        return Math.abs(kms[to] - a) * 60;
    };
}

function params(kms: Record<number, number>, over: Partial<SimParams> = {}): SimParams {
    return {
        slots: SLOTS,
        routeStartMinute: hm('09:00'),
        routeEndMinute: hm('18:00'),
        serviceMinutes: 0,
        marginPct: 0,
        travelSeconds: line(kms),
        ...over,
    };
}

const free = (id: number): SimStop => ({ id, fixedWindow: null });

describe('buildTimeSlots', () => {
    it('cuts both windows every 120 minutes and leaves the break out', () => {
        expect(SLOTS.map((s) => [s.startMinute / 60, s.endMinute / 60])).toEqual([[9, 11], [11, 13], [14, 16], [16, 18]]);
    });

    it('drops the rest that is not a whole slot', () => {
        const slots = buildTimeSlots({ start: '09:00', end: '12:00' }, { start: '14:00', end: '15:00' }, 120);
        expect(slots.map((s) => [s.startMinute / 60, s.endMinute / 60])).toEqual([[9, 11]]);
    });

    it('follows a changed slot duration', () => {
        const slots = buildTimeSlots({ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }, 60);
        expect(slots).toHaveLength(8);
    });

    it('has no slots with an invalid duration', () => {
        expect(buildTimeSlots({ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }, 0)).toEqual([]);
    });
});

describe('slotForArrival', () => {
    it('takes the first slot that has not ended', () => {
        expect(slotForArrival(SLOTS, hm('10:59'))?.startMinute).toBe(hm('09:00'));
        expect(slotForArrival(SLOTS, hm('11:00'))?.startMinute).toBe(hm('09:00'));
        expect(slotForArrival(SLOTS, hm('11:01'))?.startMinute).toBe(hm('11:00'));
    });

    it('sends an arrival in the break to the first slot of the afternoon', () => {
        expect(slotForArrival(SLOTS, hm('13:30'))?.startMinute).toBe(hm('14:00'));
    });

    it('has no slot after the last one', () => {
        expect(slotForArrival(SLOTS, hm('18:01'))).toBeNull();
    });
});

describe('simulateRoute', () => {
    it('gives each stop the slot of its arrival and accumulates the service time', () => {
        const result = simulateRoute([free(1), free(2)], params({ 1: 10, 2: 20 }, { serviceMinutes: 15 }));

        expect(result.feasible).toBe(true);
        expect(result.stops.map((s) => [s.id, s.arrivalMinute, s.window.startMinute, s.departureMinute])).toEqual([
            [1, hm('09:10'), hm('09:00'), hm('09:25')],
            [2, hm('09:35'), hm('09:00'), hm('09:50')],
        ]);
    });

    it('applies the planning margin to every leg', () => {
        const result = simulateRoute([free(1)], params({ 1: 60 }, { marginPct: 20 }));

        expect(result.stops[0].arrivalMinute).toBeCloseTo(hm('10:12'));
    });

    it('waits when it arrives before the start of a fixed window', () => {
        const stop: SimStop = { id: 1, fixedWindow: { startMinute: hm('11:00'), endMinute: hm('13:00') } };

        const result = simulateRoute([stop], params({ 1: 12 }, { serviceMinutes: 15 }));

        expect(result.feasible).toBe(true);
        expect(result.stops[0]).toMatchObject({ arrivalMinute: hm('09:12'), startMinute: hm('11:00'), departureMinute: hm('11:15'), fixed: true });
    });

    it('is feasible exactly at the end of the window and infeasible one minute later', () => {
        const at = (end: string): SimStop => ({ id: 1, fixedWindow: { startMinute: hm('09:00'), endMinute: hm(end) } });
        const p = params({ 1: 12 });

        expect(simulateRoute([at('09:12')], p).feasible).toBe(true);
        const late = simulateRoute([at('09:11')], p);
        expect(late).toMatchObject({ feasible: false, failure: 'late_for_window', failedStopId: 1 });
    });

    it('moves a derived stop that arrives in the break to the afternoon and waits for it', () => {
        const result = simulateRoute([free(1), free(2)], params({ 1: 1, 2: 210 }, { serviceMinutes: 60 }));

        // 09:01 + 60 service = 10:01; +209 min = 13:30, inside the break.
        expect(result.stops[1]).toMatchObject({ arrivalMinute: hm('13:30'), startMinute: hm('14:00') });
        expect(result.stops[1].window.startMinute).toBe(hm('14:00'));
    });

    it('is not feasible when the route would end after the afternoon window', () => {
        const kms = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        const stops = [1, 2, 3, 4, 5, 6].map(free);

        const result = simulateRoute(stops, params(kms, { serviceMinutes: 90 }));

        expect(result).toMatchObject({ feasible: false, failure: 'route_too_long' });
        expect(result.endMinute).toBe(hm('18:30'));
        // With one stop less it ends at 17:00 and is fine.
        expect(simulateRoute(stops.slice(0, 5), params(kms, { serviceMinutes: 90 })).feasible).toBe(true);
    });

    it('is not feasible when a derived stop arrives after the last slot', () => {
        const result = simulateRoute([free(1)], params({ 1: 600 }));

        expect(result).toMatchObject({ feasible: false, failure: 'no_slot', failedStopId: 1 });
    });

    it('is not feasible when OSRM has no route for a leg', () => {
        const result = simulateRoute([free(1), free(2)], params({ 1: 5, 2: 6 }, { travelSeconds: (from, to) => (to === 2 ? null : 60) }));

        expect(result).toMatchObject({ feasible: false, failure: 'no_route', failedStopId: 2 });
    });

    it('an empty route is feasible and ends where it started', () => {
        expect(simulateRoute([], params({}))).toMatchObject({ feasible: true, endMinute: hm('09:00') });
    });
});

describe('drivingSeconds', () => {
    it('sums the legs from the depot without margin or service', () => {
        expect(drivingSeconds([1, 2], line({ 1: 10, 2: 25 }))).toBe(25 * 60);
    });

    it('is null when a leg has no route', () => {
        expect(drivingSeconds([1], () => null)).toBeNull();
    });
});
