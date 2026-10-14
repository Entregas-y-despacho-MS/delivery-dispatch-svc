import {
    calculateRouteCapacity,
    type RouteCapacityDispatch,
} from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import type { PlanDispatch, PlanVehicle } from './plan-types.js';

export function toCapacityDispatch(dispatch: PlanDispatch): RouteCapacityDispatch {
    return {
        dispatchId: dispatch.dispatchId,
        estimatedWeightKg: dispatch.estimatedWeightKg,
        packages: dispatch.packages,
    };
}

/** Smallest first: by weight capacity, then volume, then id so the choice is deterministic. */
export function bySmallestVehicle(a: PlanVehicle, b: PlanVehicle): number {
    return a.capacityKg - b.capacityKg || a.capacityM3 - b.capacityM3 || a.vehicleId - b.vehicleId;
}

/** Whether all of `dispatches` fit `vehicle`: weight, volume and every package inside its maximum size. */
export function fitsVehicle(dispatches: PlanDispatch[], vehicle: PlanVehicle): boolean {
    return calculateRouteCapacity(dispatches.map(toCapacityDispatch), vehicle).assignable;
}

/**
 * The smallest vehicle where the whole group fits (D-21: "the smallest active vehicle where weight,
 * volume and packages fit"), or `null` when none does.
 */
export function smallestFittingVehicle(dispatches: PlanDispatch[], vehicles: PlanVehicle[]): PlanVehicle | null {
    return [...vehicles].sort(bySmallestVehicle).find((vehicle) => fitsVehicle(dispatches, vehicle)) ?? null;
}
