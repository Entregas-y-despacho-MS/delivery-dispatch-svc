import { describe, expect, it } from 'vitest';
import { dispatch, vehicle } from './plan-fixtures.helper-spec.js';
import { fitsVehicle, smallestFittingVehicle } from './vehicle-selection.js';

const pkg = (dispatchId: number, over: Partial<{ l: number; w: number; h: number; kg: number }> = {}) => ({
    dispatchId,
    packageId: dispatchId * 10,
    lengthCm: over.l ?? 40,
    widthCm: over.w ?? 30,
    heightCm: over.h ?? 30,
    grossWeightKg: over.kg ?? 20,
});

describe('smallestFittingVehicle', () => {
    const fleet = [vehicle(3, 1000), vehicle(1, 100), vehicle(2, 400)];

    it('picks the smallest vehicle whatever the order of the list', () => {
        expect(smallestFittingVehicle([dispatch(1, { estimatedWeightKg: 50 })], fleet)?.vehicleId).toBe(1);
    });

    it('accepts a load exactly at the capacity', () => {
        const load = [dispatch(1, { estimatedWeightKg: 60 }), dispatch(2, { estimatedWeightKg: 40 })];
        expect(smallestFittingVehicle(load, fleet)?.vehicleId).toBe(1);
    });

    it('moves up to the next vehicle when the load is one centigram over', () => {
        const load = [dispatch(1, { estimatedWeightKg: 60 }), dispatch(2, { estimatedWeightKg: 40.01 })];
        expect(smallestFittingVehicle(load, fleet)?.vehicleId).toBe(2);
    });

    it('measures volume from the packages, not only weight', () => {
        // 2 packages of 1 m³ each: 100 kg capacity is fine but 1.5 m³ is not.
        const load = [dispatch(1, { packages: [pkg(1, { l: 100, w: 100, h: 100, kg: 5 }), pkg(1, { l: 100, w: 100, h: 100, kg: 5 })] })];
        const fleetM3 = [vehicle(1, 100, 1.5), vehicle(2, 100, 3)];
        expect(smallestFittingVehicle(load, fleetM3)?.vehicleId).toBe(2);
    });

    it('skips a vehicle whose maximum package size a package exceeds', () => {
        const load = [dispatch(1, { packages: [pkg(1, { l: 180, kg: 5 })] })];
        const limited = vehicle(1, 100, 100, { maxPackageLengthCm: 120 });
        const open = vehicle(2, 400);
        expect(smallestFittingVehicle(load, [limited, open])?.vehicleId).toBe(2);
    });

    it('returns null when nothing fits', () => {
        expect(smallestFittingVehicle([dispatch(1, { estimatedWeightKg: 5000 })], fleet)).toBeNull();
    });

    it('breaks a capacity tie by volume and then by id', () => {
        const tied = [vehicle(5, 100, 10), vehicle(4, 100, 10), vehicle(6, 100, 8)];
        expect(smallestFittingVehicle([dispatch(1)], tied)?.vehicleId).toBe(6);
        expect(smallestFittingVehicle([dispatch(1)], [vehicle(5, 100, 10), vehicle(4, 100, 10)])?.vehicleId).toBe(4);
    });
});

describe('fitsVehicle', () => {
    it('is true for an empty batch', () => {
        expect(fitsVehicle([], vehicle(1, 10))).toBe(true);
    });
});
