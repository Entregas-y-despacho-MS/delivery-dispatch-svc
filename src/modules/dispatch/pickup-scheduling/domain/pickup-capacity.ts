/**
 * Capacity check of a supplier pickup (ST-75.1). A pickup has no package records, only the
 * estimates Compras sends (`estimated_weight_kg`, `estimated_volume_m3`), so
 * `calculateRouteCapacity` (which sums packages) does not apply.
 */
export interface PickupLoad {
    /** Null when Compras did not estimate it: nothing to compare. */
    estimatedWeightKg: number | null;
    estimatedVolumeM3: number | null;
}

export interface PickupVehicleCapacity {
    capacityKg: number;
    capacityM3: number;
}

export interface PickupCapacityMeasure {
    actual: number;
    capacity: number;
    excess: number;
}

export interface PickupCapacityReport {
    fits: boolean;
    /** Null when the estimate is missing. */
    weight: PickupCapacityMeasure | null;
    volume: PickupCapacityMeasure | null;
}

function measure(actual: number | null, capacity: number): PickupCapacityMeasure | null {
    if (actual === null) return null;
    return { actual, capacity, excess: Math.max(0, Math.round((actual - capacity) * 1e6) / 1e6) };
}

export function checkPickupCapacity(load: PickupLoad, vehicle: PickupVehicleCapacity): PickupCapacityReport {
    const weight = measure(load.estimatedWeightKg, vehicle.capacityKg);
    const volume = measure(load.estimatedVolumeM3, vehicle.capacityM3);
    return {
        fits: (weight?.excess ?? 0) === 0 && (volume?.excess ?? 0) === 0,
        weight,
        volume,
    };
}
