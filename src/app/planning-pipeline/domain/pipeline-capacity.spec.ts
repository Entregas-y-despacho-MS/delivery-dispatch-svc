import { describe, expect, it } from 'vitest';
import { calculateRouteCapacity } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import { capacityExceptionCodes, toPipelineCapacity } from './pipeline-capacity.js';

const vehicle = { capacityKg: 100, capacityM3: 1, maxPackageLengthCm: 100, maxPackageWidthCm: 100, maxPackageHeightCm: 100 };
const dispatch = (grossWeightKg: number, sideCm: number) => ({
    dispatchId: 1,
    estimatedWeightKg: null,
    packages: [{ dispatchId: 1, packageId: 1, lengthCm: sideCm, widthCm: sideCm, heightCm: sideCm, grossWeightKg }],
});

describe('toPipelineCapacity', () => {
    it('keeps kg and m3 as separate measures with their own unit and no combined figure', () => {
        const capacity = toPipelineCapacity(calculateRouteCapacity([dispatch(40, 50)], vehicle));
        expect(capacity.weight).toMatchObject({ unit: 'kg', actual: 40, capacity: 100, usedPercent: 40, exceeded: false });
        expect(capacity.volume).toMatchObject({ unit: 'm3', actual: 0.125, capacity: 1, usedPercent: 12.5, exceeded: false });
        expect(Object.keys(capacity).sort()).toEqual(['dimensionViolationCount', 'volume', 'weight']);
    });

    it('flags only the unit that exceeds: heavy but small is a kg excess, light but bulky is a m3 excess', () => {
        const heavy = toPipelineCapacity(calculateRouteCapacity([dispatch(130, 50)], vehicle));
        expect(heavy.weight).toMatchObject({ exceeded: true, excess: 30 });
        expect(heavy.volume.exceeded).toBe(false);
        expect(capacityExceptionCodes(heavy)).toEqual(['capacity_exceeded_kg']);

        const bulky = toPipelineCapacity(calculateRouteCapacity([dispatch(10, 100)], { ...vehicle, capacityM3: 0.5 }));
        expect(bulky.volume).toMatchObject({ exceeded: true, excess: 0.5 });
        expect(bulky.weight.exceeded).toBe(false);
        expect(capacityExceptionCodes(bulky)).toEqual(['capacity_exceeded_m3']);
    });

    it('does not flag a load that exactly fills the vehicle', () => {
        const exact = toPipelineCapacity(calculateRouteCapacity([dispatch(100, 100)], vehicle));
        expect(capacityExceptionCodes(exact)).toEqual([]);
    });

    it('counts the packages that exceed the vehicle dimensions apart from weight and volume', () => {
        const capacity = toPipelineCapacity(calculateRouteCapacity([dispatch(10, 60)], { ...vehicle, maxPackageLengthCm: 50 }));
        expect(capacity.dimensionViolationCount).toBe(1);
        expect(capacityExceptionCodes(capacity)).toEqual(['package_dimensions_exceeded']);
    });
});

describe('capacityExceptionCodes', () => {
    it('returns no code without a vehicle: there is nothing to compare', () => {
        expect(capacityExceptionCodes(null)).toEqual([]);
    });
});
