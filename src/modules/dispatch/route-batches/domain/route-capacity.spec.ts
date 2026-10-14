import { describe, expect, it } from 'vitest';
import {
  calculateRouteCapacity,
  type RouteCapacityDispatch,
  type VehicleCapacity,
} from './route-capacity.js';

const vehicle: VehicleCapacity = {
  capacityKg: 100,
  capacityM3: 1,
  maxPackageLengthCm: 100,
  maxPackageWidthCm: 80,
  maxPackageHeightCm: 60,
};

const parcel = (
  overrides: Partial<RouteCapacityDispatch['packages'][number]> = {},
): RouteCapacityDispatch['packages'][number] => ({
  dispatchId: 1,
  packageId: 11,
  lengthCm: 100,
  widthCm: 100,
  heightCm: 100,
  grossWeightKg: 50,
  ...overrides,
});

describe('calculateRouteCapacity', () => {
  it('totals package weight and volume and reports utilization and remaining capacity', () => {
    const report = calculateRouteCapacity(
      [
        {
          dispatchId: 1,
          estimatedWeightKg: null,
          packages: [parcel({ lengthCm: 10 })],
        },
        {
          dispatchId: 2,
          estimatedWeightKg: null,
          packages: [
            parcel({ packageId: 22, grossWeightKg: 25, lengthCm: 10 }),
          ],
        },
      ],
      {
        ...vehicle,
        maxPackageLengthCm: null,
        maxPackageWidthCm: null,
        maxPackageHeightCm: null,
      },
    );

    expect(report.weight).toEqual({
      actual: 75,
      capacity: 100,
      usedPercent: 75,
      remaining: 25,
      excess: 0,
    });
    expect(report.volume).toEqual({
      actual: 0.2,
      capacity: 1,
      usedPercent: 20,
      remaining: 0.8,
      excess: 0,
    });
    expect(report.assignable).toBe(true);
  });

  it('uses estimated weight for a dispatch without packages and identifies it as estimated', () => {
    const report = calculateRouteCapacity(
      [{ dispatchId: 3, estimatedWeightKg: 17.25, packages: [] }],
      vehicle,
    );

    expect(report.weight.actual).toBe(17.25);
    expect(report.volume.actual).toBe(0);
    expect(report.estimatedDispatchIds).toEqual([3]);
  });

  it('blocks load above the limit and returns the exact excess', () => {
    const report = calculateRouteCapacity(
      [
        {
          dispatchId: 1,
          estimatedWeightKg: null,
          packages: [parcel({ grossWeightKg: 101 })],
        },
      ],
      vehicle,
    );

    expect(report.weight).toMatchObject({
      usedPercent: 101,
      remaining: 0,
      excess: 1,
    });
    expect(report.assignable).toBe(false);
  });

  it('blocks an excess that is smaller than the displayed rounding precision', () => {
    const report = calculateRouteCapacity(
      [
        {
          dispatchId: 1,
          estimatedWeightKg: null,
          packages: [parcel({ lengthCm: 100.01, widthCm: 100, heightCm: 100 })],
        },
      ],
      {
        ...vehicle,
        maxPackageLengthCm: null,
        maxPackageWidthCm: null,
        maxPackageHeightCm: null,
      },
    );

    expect(report.volume.actual).toBe(1.0001);
    expect(report.volume.excess).toBe(0.0001);
    expect(report.assignable).toBe(false);
  });

  it('reports volume excess to the precision supported by package dimensions', () => {
    const report = calculateRouteCapacity(
      [
        {
          dispatchId: 1,
          estimatedWeightKg: null,
          packages: [
            parcel({ lengthCm: 100.01, widthCm: 100.01, heightCm: 100.01 }),
          ],
        },
      ],
      {
        ...vehicle,
        capacityM3: 1.00030003,
        maxPackageLengthCm: null,
        maxPackageWidthCm: null,
        maxPackageHeightCm: null,
      },
    );

    expect(report.volume.actual).toBe(1.000300030001);
    expect(report.volume.excess).toBe(0.000000000001);
    expect(report.assignable).toBe(false);
  });

  it('allows a load exactly at capacity', () => {
    const report = calculateRouteCapacity(
      [
        {
          dispatchId: 1,
          estimatedWeightKg: null,
          packages: [
            parcel({
              grossWeightKg: 100,
              lengthCm: 100,
              widthCm: 80,
              heightCm: 60,
            }),
          ],
        },
      ],
      vehicle,
    );

    expect(report.weight.excess).toBe(0);
    expect(report.volume.excess).toBe(0);
    expect(report.dimensionViolations).toEqual([]);
    expect(report.assignable).toBe(true);
  });

  it('reports each package dimension that exceeds the vehicle limit', () => {
    const report = calculateRouteCapacity(
      [{ dispatchId: 1, estimatedWeightKg: null, packages: [parcel()] }],
      vehicle,
    );

    expect(report.dimensionViolations).toEqual([
      {
        dispatchId: 1,
        packageId: 11,
        exceeded: [
          { dimension: 'widthCm', actual: 100, maximum: 80 },
          { dimension: 'heightCm', actual: 100, maximum: 60 },
        ],
      },
    ]);
  });

  it('ignores dimensions without configured vehicle limits', () => {
    const report = calculateRouteCapacity(
      [{ dispatchId: 1, estimatedWeightKg: null, packages: [parcel()] }],
      {
        ...vehicle,
        maxPackageLengthCm: null,
        maxPackageWidthCm: null,
        maxPackageHeightCm: null,
      },
    );

    expect(report.dimensionViolations).toEqual([]);
  });
});
