export interface RouteCapacityPackage {
  dispatchId: number;
  packageId: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  grossWeightKg: number;
}

export interface RouteCapacityDispatch {
  dispatchId: number;
  estimatedWeightKg: number | null;
  packages: RouteCapacityPackage[];
}

export interface VehicleCapacity {
  capacityKg: number;
  capacityM3: number;
  maxPackageLengthCm: number | null;
  maxPackageWidthCm: number | null;
  maxPackageHeightCm: number | null;
}

export interface CapacityMeasure {
  actual: number;
  capacity: number;
  usedPercent: number;
  remaining: number;
  excess: number;
}

export interface PackageDimensionViolation {
  dispatchId: number;
  packageId: number;
  exceeded: Array<{
    dimension: 'lengthCm' | 'widthCm' | 'heightCm';
    actual: number;
    maximum: number;
  }>;
}

export interface RouteCapacityReport {
  estimatedDispatchIds: number[];
  weight: CapacityMeasure;
  volume: CapacityMeasure;
  dimensionViolations: PackageDimensionViolation[];
  assignable: boolean;
}

/** Calculates the vehicle load from package records, falling back to estimated dispatch weight. */
export function calculateRouteCapacity(
  dispatches: RouteCapacityDispatch[],
  vehicle: VehicleCapacity,
): RouteCapacityReport {
  let weightKg = 0;
  let volumeM3 = 0;
  const estimatedDispatchIds: number[] = [];
  const dimensionViolations: PackageDimensionViolation[] = [];

  for (const dispatch of dispatches) {
    if (dispatch.packages.length === 0) {
      weightKg += dispatch.estimatedWeightKg ?? 0;
      estimatedDispatchIds.push(dispatch.dispatchId);
      continue;
    }

    for (const pkg of dispatch.packages) {
      weightKg += pkg.grossWeightKg;
      volumeM3 += (pkg.lengthCm * pkg.widthCm * pkg.heightCm) / 1_000_000;

      const exceeded: PackageDimensionViolation['exceeded'] = [];
      const dimensions = [
        ['lengthCm', pkg.lengthCm, vehicle.maxPackageLengthCm],
        ['widthCm', pkg.widthCm, vehicle.maxPackageWidthCm],
        ['heightCm', pkg.heightCm, vehicle.maxPackageHeightCm],
      ] as const;
      for (const [dimension, actual, maximum] of dimensions) {
        if (maximum !== null && actual > maximum)
          exceeded.push({ dimension, actual, maximum });
      }
      if (exceeded.length > 0)
        dimensionViolations.push({
          dispatchId: dispatch.dispatchId,
          packageId: pkg.packageId,
          exceeded,
        });
    }
  }

  const weight = measure(weightKg, vehicle.capacityKg, 6);
  // Package dimensions are stored to two decimal places in centimeters, so their
  // product can require twelve decimal places after conversion to cubic meters.
  const volume = measure(volumeM3, vehicle.capacityM3, 12);
  return {
    estimatedDispatchIds,
    weight,
    volume,
    dimensionViolations,
    assignable:
      weightKg <= vehicle.capacityKg &&
      volumeM3 <= vehicle.capacityM3 &&
      dimensionViolations.length === 0,
  };
}

function measure(
  actual: number,
  capacity: number,
  decimalPlaces: number,
): CapacityMeasure {
  const roundedActual = round(actual, decimalPlaces);
  const roundedCapacity = round(capacity, decimalPlaces);
  return {
    actual: roundedActual,
    capacity: roundedCapacity,
    usedPercent: roundedCapacity > 0 ? round((actual / capacity) * 100, 2) : 0,
    remaining: round(Math.max(0, capacity - actual), decimalPlaces),
    excess: round(Math.max(0, actual - capacity), decimalPlaces),
  };
}

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
