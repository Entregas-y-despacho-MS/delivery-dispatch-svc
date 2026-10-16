/**
 * Shapes of the D-1 cutoff (ST-51.3, D-11). Plain data: what the repository reads, what the
 * reoptimization decides and what the writer persists. Nothing here knows Nest, SQL or OSRM.
 */
import type { PlanningSettings } from '../../planning/domain/planning-settings.js';
import type { AgreedWindow, PlanDispatch, PlanVehicle } from '../../planning/domain/plan-types.js';
import type { TravelSeconds } from '../../planning/domain/route-simulation.js';

/** A stop of a provisional batch as the cutoff reads it. */
export interface CutoffStop {
    /** Capacity data (weight and packages) and zone; `status` is `in_planning` or `scheduled`. */
    dispatch: PlanDispatch;
    /** Position in the batch when it was read (1-based). */
    sequence: number;
    /** Planning version of the dispatch when it was read (D-09). */
    version: number;
    promiseNotifiedAt: Date | null;
    promiseFirmedAt: Date | null;
    /** `scheduled_window_*`: the slot promised to the customer. */
    window: AgreedWindow | null;
}

export interface CutoffBatch {
    routeBatchId: number;
    version: number;
    shiftDate: string;
    zoneId: number;
    zoneCode: string;
    zoneName: string;
    warehouseId: number;
    vehicleId: number | null;
    proposedDriverId: number | null;
    reviewerUserId: number | null;
    /** In visiting order. */
    stops: CutoffStop[];
}

export interface CutoffInput {
    now: Date;
    settings: PlanningSettings;
    /** The `provisional` batches of the day that leaves tomorrow. */
    batches: CutoffBatch[];
    /** Active vehicles of the fleet. */
    fleet: PlanVehicle[];
    /** Vehicles held that day by batches that are not being processed (`pending_final_review`, `confirmed`...). */
    occupiedVehicleIds: number[];
    /** Most stops one batch may have: the `table` limit of OSRM minus the depot. */
    maxStopsPerBatch: number;
    /** Driving time in seconds between dispatch ids of one zone and warehouse (`null` is the depot). */
    travelFor: (warehouseId: number, zoneId: number) => TravelSeconds;
}

/** Why a stop enters the cutoff or stays out of it. */
export type CutoffEligibility =
    /** `promise_firmed_at` is set. */
    | 'firm'
    /** Valid notice and the response window already closed. */
    | 'window_elapsed'
    /** Promised, but the customer can still answer (or no valid notice yet): stays out. */
    | 'window_open'
    /** Never approved (`in_planning`): has no promise, goes back to `pending`. */
    | 'no_promise';

export type CutoffMovementKind = 'merged' | 'split' | 'moved';

export interface CutoffMovement {
    kind: CutoffMovementKind;
    fromBatchId: number;
    /** Existing batch that received the stops; `null` when they went to a new batch (`toNewRef`). */
    toBatchId: number | null;
    toNewRef: string | null;
    dispatchIds: number[];
}

/** A batch that leaves the cutoff with its final content (an existing row, or a new one when `routeBatchId` is null). */
export interface CutoffBatchPlan {
    routeBatchId: number | null;
    /** Reference of a new batch, used by `CutoffMovement.toNewRef`. */
    newRef: string | null;
    /** Version of the batch when it was read; the writer drops the change if it moved. `null` for a new batch. */
    expectedVersion: number | null;
    shiftDate: string;
    zoneId: number;
    zoneCode: string;
    zoneName: string;
    warehouseId: number;
    vehicleId: number | null;
    proposedDriverId: number | null;
    reviewerUserId: number | null;
    /** Final visiting order. */
    stops: Array<{ dispatchId: number; sequence: number; version: number }>;
    /** Batches whose stops were merged into this one (they are cancelled). */
    absorbedBatchIds: number[];
    /** Set for a batch born by splitting another. */
    splitFromBatchId: number | null;
    /** The reoptimization could not make every stop feasible: the validator will fail it with the reason. */
    reoptimizationIncomplete: boolean;
}

/** Stops with an open window: they wait in a provisional batch of the same zone and day, with their slot intact. */
export interface CutoffRemnant {
    /** Batch that held them. The remnant is a new provisional batch with no vehicle (the vehicle goes with the firm ones). */
    sourceBatchId: number;
    shiftDate: string;
    zoneId: number;
    zoneCode: string;
    zoneName: string;
    warehouseId: number;
    reviewerUserId: number | null;
    dispatchIds: number[];
    /** Batch each of them was in (differs from `sourceBatchId` when a merge brought them along). */
    sourceBatchByDispatch: Record<number, number>;
}

/** Stops of an untouched batch (no firm stop at all): stays `provisional` as it is. */
export interface CutoffUntouchedBatch {
    routeBatchId: number;
    openDispatchIds: number[];
}

export interface CutoffRelease {
    dispatchId: number;
    fromBatchId: number;
    reason: 'no_promise';
}

export interface CutoffPlan {
    batches: CutoffBatchPlan[];
    remnants: CutoffRemnant[];
    untouched: CutoffUntouchedBatch[];
    released: CutoffRelease[];
    movements: CutoffMovement[];
    /** Batches left with nothing (merged into another, or only released stops). */
    cancelledBatchIds: number[];
}
