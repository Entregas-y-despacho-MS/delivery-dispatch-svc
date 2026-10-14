/**
 * Shapes shared by the plan generator (ST-50.2). Plain data: what the repository reads, what the
 * planner decides and what the writer persists. Nothing here knows Nest, SQL or OSRM.
 */
import type { RouteCapacityPackage, VehicleCapacity } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import type { PlanningSettings } from './planning-settings.js';

/** A delivery waiting for a batch: `pending`, or `rescheduled` with no batch yet. */
export interface PlanDispatch {
    dispatchId: number;
    zoneId: number;
    warehouseId: number;
    latitude: number;
    longitude: number;
    /** `urgent` only orders the queue (D-16). */
    priority: string;
    /** D0 is taken from here. */
    orderConfirmedAt: Date;
    status: 'pending' | 'rescheduled';
    /** `rescheduled` only: the agreed local date, never recomputed (D-49). */
    fixedDate: string | null;
    estimatedWeightKg: number | null;
    packages: RouteCapacityPackage[];
}

export interface PlanVehicle extends VehicleCapacity {
    vehicleId: number;
}

export interface PlanWarehouse {
    warehouseId: number;
    latitude: number;
    longitude: number;
}

/** A batch that already exists and is not cancelled: it occupies its vehicle and its driver that day. */
export interface ExistingBatchSummary {
    shiftDate: string;
    vehicleId: number | null;
    driverId: number | null;
    proposedDriverId: number | null;
}

export interface PlanInput {
    now: Date;
    settings: PlanningSettings;
    /** In queue order: urgent first, then oldest confirmation. */
    dispatches: PlanDispatch[];
    vehicles: PlanVehicle[];
    driverIds: number[];
    warehouses: PlanWarehouse[];
    existingBatches: ExistingBatchSummary[];
}

export interface ProposedStop {
    dispatchId: number;
    /** 1-based position in the route. */
    sequence: number;
}

export interface ProposedBatch {
    shiftDate: string;
    zoneId: number;
    warehouseId: number;
    vehicleId: number;
    /** Larger free vehicles that also fit, in the order to try if `vehicleId` is taken meanwhile. */
    alternativeVehicleIds: number[];
    proposedDriverId: number | null;
    stops: ProposedStop[];
    /** Why one group became several batches, if it did. */
    splitReason: 'capacity' | 'table_limit' | null;
    rescheduledDispatchIds: number[];
}

/** Orders that stay `pending` and open an exception for the coordinator. */
export type UnplannedReason =
    | 'deadline_exceeded'
    | 'no_vehicle_fits'
    | 'rescheduled_date_not_plannable'
    | 'no_vehicle_available';

export interface UnplannedDispatch {
    dispatchId: number;
    reason: UnplannedReason;
    detail: Record<string, unknown>;
}

export type PlanWarningKind =
    | 'below_min_orders'
    | 'no_driver_available'
    | 'holidays_not_configured'
    | 'lot_split_by_table_limit';

export interface PlanWarning {
    kind: PlanWarningKind;
    detail: Record<string, unknown>;
}

export interface PlanProposal {
    batches: ProposedBatch[];
    unplanned: UnplannedDispatch[];
    warnings: PlanWarning[];
}
