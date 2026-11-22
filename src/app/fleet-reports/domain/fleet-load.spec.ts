import { describe, expect, it } from 'vitest';
import { buildVehicleLoad, type RouteLoad } from './fleet-load.js';

const route = (over: Partial<RouteLoad> = {}): RouteLoad => ({ routeBatchId: 1, vehicleId: 1, dispatches: 3, weightKg: 400, volumeM3: 2, withoutWeight: 0, withoutVolume: 0, ...over });

describe('buildVehicleLoad', () => {
    it('answers N/D with its reason when the vehicle has no approved route', () => {
        expect(buildVehicleLoad([], 1000, 10)).toEqual({ kg: null, m3: null, routes: 0, n: 0, withoutWeight: 0, withoutVolume: 0, unavailableReason: 'no_route_in_period' });
    });

    it('keeps kg and m3 apart, each against its own capacity', () => {
        const load = buildVehicleLoad([route()], 1000, 8);
        expect(load.kg).toEqual({ used: 400, capacity: 1000, ratio: 0.4 });
        expect(load.m3).toEqual({ used: 2, capacity: 8, ratio: 0.25 });
        expect(load).toMatchObject({ routes: 1, n: 3, unavailableReason: null });
    });

    it('takes the heaviest route, not the sum of several days (a capacity is per trip)', () => {
        const load = buildVehicleLoad([route({ routeBatchId: 1, weightKg: 300, volumeM3: 6 }), route({ routeBatchId: 2, weightKg: 700, volumeM3: 1 })], 1000, 10);
        expect(load.kg?.used).toBe(700);
        expect(load.m3?.used).toBe(6);
        expect(load).toMatchObject({ routes: 2, n: 6 });
    });

    it('does not cap the ratio: above 1 means over capacity', () => {
        expect(buildVehicleLoad([route({ weightKg: 1500 })], 1000, 10).kg?.ratio).toBe(1.5);
    });

    it('marks N/D the figure no dispatch has the estimate for, and keeps the other', () => {
        const load = buildVehicleLoad([route({ withoutWeight: 3 })], 1000, 10);
        expect(load.kg).toBeNull();
        expect(load.m3).not.toBeNull();
        expect(load.unavailableReason).toBeNull();
    });

    it('reports a lower bound when only some dispatches lack the estimate', () => {
        const load = buildVehicleLoad([route({ withoutWeight: 1 })], 1000, 10);
        expect(load.kg?.used).toBe(400);
        expect(load.withoutWeight).toBe(1);
    });

    it('answers no_estimate when no dispatch has either estimate', () => {
        const load = buildVehicleLoad([route({ withoutWeight: 3, withoutVolume: 3 })], 1000, 10);
        expect(load).toMatchObject({ kg: null, m3: null, routes: 1, unavailableReason: 'no_estimate' });
    });

    it('answers N/D for a figure whose capacity is not positive instead of dividing by zero', () => {
        expect(buildVehicleLoad([route()], 0, 10).kg).toBeNull();
    });
});
