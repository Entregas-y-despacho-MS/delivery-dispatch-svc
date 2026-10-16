import { calculateRouteCapacity } from './route-capacity.js';
import { summarizeOccupancy, toValidation } from './route-batch-view.js';

const vehicle = { capacityKg: 100, capacityM3: 1, maxPackageLengthCm: null, maxPackageWidthCm: null, maxPackageHeightCm: null };
const at = new Date('2026-10-16T20:00:00Z');

describe('summarizeOccupancy', () => {
  it('returns null for a batch without vehicle', () => {
    expect(summarizeOccupancy(null)).toBeNull();
  });

  it('keeps load, capacity and percentage and marks the estimated dispatches', () => {
    const report = calculateRouteCapacity(
      [
        { dispatchId: 1, estimatedWeightKg: 20, packages: [] },
        {
          dispatchId: 2,
          estimatedWeightKg: null,
          packages: [{ dispatchId: 2, packageId: 9, lengthCm: 100, widthCm: 50, heightCm: 20, grossWeightKg: 30 }],
        },
      ],
      vehicle,
    );
    expect(summarizeOccupancy(report)).toEqual({
      weight: { actual: 50, capacity: 100, usedPercent: 50 },
      volume: { actual: 0.1, capacity: 1, usedPercent: 10 },
      estimatedDispatchIds: [1],
      assignable: true,
    });
  });
});

describe('toValidation', () => {
  it('returns null when the batch never went through the cutoff', () => {
    expect(toValidation(null)).toBeNull();
  });

  it('reads a failed validation with its reason, failures and warnings', () => {
    const failure = { code: 'capacity_exceeded', dispatchIds: [3], detail: {} };
    const warning = { code: 'driver_missing', dispatchIds: [], detail: {} };
    expect(
      toValidation({ eventType: 'cutoff_failed', createdAt: at, reason: 'capacity_exceeded', metadata: { failures: [failure], warnings: [warning] } }),
    ).toEqual({ result: 'failed', occurredAt: at, reason: 'capacity_exceeded', failures: [failure], warnings: [warning] });
  });

  it('reads a passed validation and tolerates missing metadata', () => {
    expect(toValidation({ eventType: 'cutoff_validated', createdAt: at, reason: null, metadata: null })).toEqual({
      result: 'validated',
      occurredAt: at,
      reason: null,
      failures: [],
      warnings: [],
    });
  });

  it('ignores events that are not a cutoff result', () => {
    expect(toValidation({ eventType: 'reviewer_reassigned', createdAt: at, reason: null, metadata: null })).toBeNull();
  });
});
