/**
 * Validation of a batch at the D-1 cutoff (ST-51.3, §5.2 of the plan). Pure: the service reads the
 * facts under the transaction and this decides. Same checks the 2nd approval repeats (ST-51.2), so a
 * batch that leaves the cutoff in `pending_final_review` is one a coordinator can approve.
 *
 * A failure sends the batch back to `provisional` with its reasons. A warning does not: a missing
 * proposed driver is chosen by the coordinator in the 2nd approval (D-21), so it must not hide the
 * batch from the review screen.
 */
import {
    calculateRouteCapacity,
    type RouteCapacityReport,
} from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import type { AgreedWindow, PlanDispatch, PlanVehicle } from '../../planning/domain/plan-types.js';
import { simulateRoute, type SimFailure, type SimParams, type SimStop } from '../../planning/domain/route-simulation.js';
import { toLocalMoment } from '../../scheduler/domain/task-schedule.js';
import { toCapacityDispatch } from '../../planning/domain/vehicle-selection.js';

export type CutoffFailureCode =
    | 'batch_version_changed'
    | 'batch_not_found'
    | 'dispatch_version_changed'
    | 'dispatch_not_found'
    | 'dispatch_status_changed'
    | 'dispatch_in_other_batch'
    | 'dispatch_duplicated'
    | 'destination_incomplete'
    | 'packages_missing'
    | 'vehicle_missing'
    | 'vehicle_inactive'
    | 'vehicle_conflict'
    | 'capacity_exceeded'
    | 'package_too_large'
    | 'driver_inactive'
    | 'driver_conflict'
    | 'slot_not_met'
    | 'reoptimization_incomplete';

export type CutoffWarningCode = 'driver_missing';

export interface CutoffIssue<Code extends string = CutoffFailureCode> {
    code: Code;
    /** Dispatches involved, when the issue is about some of them. */
    dispatchIds: number[];
    /** Machine-readable data for the coordinator's screen and for the event metadata. */
    detail: Record<string, unknown>;
}

export interface CutoffValidation {
    passed: boolean;
    failures: Array<CutoffIssue>;
    warnings: Array<CutoffIssue<CutoffWarningCode>>;
    /** `null` when there was no vehicle to compare against. */
    capacity: RouteCapacityReport | null;
}

export interface StopFacts {
    dispatchId: number;
    sequence: number;
    /** Version of the dispatch the cutoff read. */
    expectedVersion: number;
    /** Version now, under lock; `null` when the row is gone. */
    currentVersion: number | null;
    /** Name of the current `dispatch_statuses` row. */
    status: string;
    /** `dispatches.route_batch_id` now. */
    currentRouteBatchId: number | null;
    hasDestination: boolean;
    window: AgreedWindow | null;
    dispatch: PlanDispatch;
}

export interface BatchFacts {
    routeBatchId: number | null;
    /** Version the cutoff read; `null` for a batch that is being created. */
    expectedVersion: number | null;
    /** Version now, under lock; `null` when the row is gone or the batch is new. */
    currentVersion: number | null;
    /** Batches the stops may still point to: the batch itself, the ones it absorbed and the one it was split from. */
    allowedBatchIds: number[];
    vehicleId: number | null;
    /** The vehicle as the fleet lists it; `null` when it is not an active vehicle. */
    vehicle: PlanVehicle | null;
    /** Another non-cancelled batch holding the same vehicle the same day. */
    vehicleConflictBatchId: number | null;
    proposedDriverId: number | null;
    /** `false` when the proposed driver is no longer an active driver. */
    driverActive: boolean;
    driverConflictBatchId: number | null;
    /** In visiting order. */
    stops: StopFacts[];
    reoptimizationIncomplete: boolean;
}

/** The state a promised, not yet assigned order must be in at the cutoff. */
const EXPECTED_STATUS = 'scheduled';

export function validateCutoffBatch(facts: BatchFacts, params: SimParams): CutoffValidation {
    const failures: CutoffIssue[] = [];
    const warnings: Array<CutoffIssue<CutoffWarningCode>> = [];
    const fail = (code: CutoffFailureCode, dispatchIds: number[], detail: Record<string, unknown> = {}): void => {
        failures.push({ code, dispatchIds, detail });
    };
    const ids = (stops: StopFacts[]): number[] => stops.map((stop) => stop.dispatchId);

    // Versions (D-09): somebody changed the batch or an order while the cutoff was computing.
    if (facts.routeBatchId !== null) {
        if (facts.currentVersion === null) fail('batch_not_found', []);
        else if (facts.currentVersion !== facts.expectedVersion) {
            fail('batch_version_changed', [], { expected: facts.expectedVersion, current: facts.currentVersion });
        }
    }
    const missing = facts.stops.filter((stop) => stop.currentVersion === null);
    if (missing.length > 0) fail('dispatch_not_found', ids(missing));
    const stale = facts.stops.filter((stop) => stop.currentVersion !== null && stop.currentVersion !== stop.expectedVersion);
    if (stale.length > 0) {
        fail('dispatch_version_changed', ids(stale), {
            versions: stale.map((stop) => ({ dispatchId: stop.dispatchId, expected: stop.expectedVersion, current: stop.currentVersion })),
        });
    }
    const moved = facts.stops.filter((stop) => stop.currentVersion !== null && stop.status !== EXPECTED_STATUS);
    if (moved.length > 0) {
        fail('dispatch_status_changed', ids(moved), {
            statuses: moved.map((stop) => ({ dispatchId: stop.dispatchId, status: stop.status })),
        });
    }

    // Single membership: an order belongs to one active batch only.
    const elsewhere = facts.stops.filter(
        (stop) => stop.currentRouteBatchId !== null && !facts.allowedBatchIds.includes(stop.currentRouteBatchId),
    );
    if (elsewhere.length > 0) {
        fail('dispatch_in_other_batch', ids(elsewhere), {
            batches: elsewhere.map((stop) => ({ dispatchId: stop.dispatchId, routeBatchId: stop.currentRouteBatchId })),
        });
    }

    const noDestination = facts.stops.filter((stop) => !stop.hasDestination);
    if (noDestination.length > 0) fail('destination_incomplete', ids(noDestination));
    const noPackages = facts.stops.filter((stop) => stop.dispatch.packages.length === 0);
    if (noPackages.length > 0) fail('packages_missing', ids(noPackages));

    // Vehicle and capacity.
    let capacity: RouteCapacityReport | null = null;
    if (facts.vehicleId === null) {
        fail('vehicle_missing', []);
    } else if (facts.vehicle === null) {
        fail('vehicle_inactive', [], { vehicleId: facts.vehicleId });
    } else {
        if (facts.vehicleConflictBatchId !== null) {
            fail('vehicle_conflict', [], { vehicleId: facts.vehicleId, routeBatchId: facts.vehicleConflictBatchId });
        }
        capacity = calculateRouteCapacity(facts.stops.map((stop) => toCapacityDispatch(stop.dispatch)), facts.vehicle);
        if (capacity.weight.excess > 0 || capacity.volume.excess > 0) {
            fail('capacity_exceeded', [], {
                weightExcessKg: capacity.weight.excess,
                volumeExcessM3: capacity.volume.excess,
                weightUsedPercent: capacity.weight.usedPercent,
                volumeUsedPercent: capacity.volume.usedPercent,
            });
        }
        if (capacity.dimensionViolations.length > 0) {
            fail('package_too_large', [...new Set(capacity.dimensionViolations.map((v) => v.dispatchId))], {
                violations: capacity.dimensionViolations,
            });
        }
    }

    // Driver: a missing proposal is for the coordinator to fill; an assigned one must be usable.
    if (facts.proposedDriverId === null) {
        warnings.push({ code: 'driver_missing', dispatchIds: [], detail: {} });
    } else {
        if (!facts.driverActive) fail('driver_inactive', [], { driverId: facts.proposedDriverId });
        if (facts.driverConflictBatchId !== null) {
            fail('driver_conflict', [], { driverId: facts.proposedDriverId, routeBatchId: facts.driverConflictBatchId });
        }
    }

    // Slots with margin: the promised window is fixed; the route is simulated in the order of the plan.
    const simStops: SimStop[] = facts.stops.map((stop) => ({
        id: stop.dispatchId,
        fixedWindow: stop.window
            ? { startMinute: toLocalMoment(stop.window.start).minuteOfDay, endMinute: toLocalMoment(stop.window.end).minuteOfDay }
            : null,
    }));
    const simulation = simulateRoute(simStops, params);
    if (!simulation.feasible) {
        fail('slot_not_met', simulation.failedStopId === null ? [] : [simulation.failedStopId], {
            reason: simulation.failure satisfies SimFailure | null,
            failedDispatchId: simulation.failedStopId,
            endMinute: simulation.endMinute,
        });
    }

    if (facts.reoptimizationIncomplete) fail('reoptimization_incomplete', []);

    return { passed: failures.length === 0, failures, warnings, capacity };
}

/** A dispatch that two batches of the same proposal both claim. Checked on the whole plan. */
export function findDuplicatedDispatches(batches: Array<{ stops: Array<{ dispatchId: number }> }>): number[] {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    for (const batch of batches) {
        for (const stop of batch.stops) {
            if (seen.has(stop.dispatchId)) duplicated.add(stop.dispatchId);
            seen.add(stop.dispatchId);
        }
    }
    return [...duplicated];
}
