/**
 * Shapes shared by the plan generator (ST-50.2). Plain data: what the repository reads, what the
 * planner decides and what the writer persists. Nothing here knows Nest, SQL or OSRM.
 */
import type { RouteCapacityPackage, VehicleCapacity } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import type { PlanningSettings } from './planning-settings.js';

export interface AgreedWindow {
    start: Date;
    end: Date;
}

/**
 * A delivery waiting for a batch (`pending`, or `rescheduled` with no batch yet), a customer pickup
 * waiting for one (`pickup_scheduled`), or a stop of an open batch.
 */
export interface PlanDispatch {
    dispatchId: number;
    /** Dispatch catalog type; supplier pickups are planned only with other supplier pickups. */
    dispatchType: string;
    zoneId: number | null;
    /** `delivery_zones.code`, for alerts a coordinator can read ("ZON-SUR"). */
    zoneCode: string;
    zoneName: string;
    /** The zone was soft-deleted from the catalog. The order is still planned, with a warning. */
    zoneDeleted: boolean;
    /** The hub the batch is tied to: a delivery's `origin_warehouse_id`, or a pickup's `destination_warehouse_id` — the vehicle starts and ends there either way. */
    warehouseId: number;
    /** Supplier pickup only: vehicle selected and capacity-checked when its appointment was accepted. */
    preferredVehicleId?: number | null;
    latitude: number;
    longitude: number;
    /** `urgent` only orders the queue (D-16). */
    priority: string;
    /** D0 is taken from here. For a pickup with no history to speak of, its `created_at`. */
    orderConfirmedAt: Date;
    status: 'pending' | 'rescheduled' | 'pickup_scheduled' | 'in_planning' | 'scheduled';
    /** The agreed local date, never recomputed (D-49): a `rescheduled` delivery's, or a pickup's own `preferredPickupDate` when it gave one — `null` otherwise, including an undated pickup, which is planned like a `pending` delivery instead. */
    fixedDate: string | null;
    /** `rescheduled` only: the window agreed with the customer, kept as it is. */
    agreedWindow: AgreedWindow | null;
    estimatedWeightKg: number | null;
    estimatedVolumeM3?: number | null;
    packages: RouteCapacityPackage[];
}

export interface PlanVehicle extends VehicleCapacity {
    vehicleId: number;
}

export interface PlanWarehouse {
    warehouseId: number;
    latitude: number;
    longitude: number;
    /** Local receiving close time (`HH:mm:ss`), when configured. */
    receptionEndTime?: string | null;
}

/** A batch that already exists and is not cancelled: it occupies its vehicle and its driver that day. */
export interface ExistingBatchSummary {
    shiftDate: string;
    vehicleId: number | null;
    driverId: number | null;
    proposedDriverId: number | null;
}

export interface OpenBatchStop {
    dispatch: PlanDispatch;
    sequence: number;
    /** The customer was already told the window: it never moves (D-10). */
    notified: boolean;
    /** `scheduled_window_*` as stored; fixed when `notified`, a proposal otherwise. */
    window: AgreedWindow | null;
}

/** A provisional batch whose cutoff has not passed: late orders may still be inserted (D-10). */
export interface OpenBatch {
    routeBatchId: number;
    /** Optimistic version of the batch when it was read. */
    version: number;
    shiftDate: string;
    zoneId: number;
    zoneCode: string;
    zoneName: string;
    warehouseId: number;
    vehicleId: number;
    /** In visiting order. */
    stops: OpenBatchStop[];
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
    /** Provisional batches that may still receive late orders. */
    openBatches: OpenBatch[];
}

export interface ProposedStop {
    dispatchId: number;
    /** 1-based position in the route. */
    sequence: number;
    /**
     * The window to store as the proposal (or the agreed one of a rescheduled order). `null` leaves
     * `scheduled_window_*` untouched: a notified stop keeps the window the customer was told.
     */
    windowStart: Date | null;
    windowEnd: Date | null;
}

export interface ProposedBatch {
    shiftDate: string;
    zoneId: number | null;
    zoneCode: string;
    zoneName: string;
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

export interface InsertedStop extends ProposedStop {
    /** Sequence it had before this run; `null` for an order that is new in the batch. */
    previousSequence: number | null;
    isNew: boolean;
}

/** Late orders inserted into an open batch, with the whole batch renumbered (D-32). */
export interface ProposedInsertion {
    routeBatchId: number;
    /** The version the plan was computed against; the writer drops the insertion if it moved. */
    expectedVersion: number;
    shiftDate: string;
    zoneId: number;
    zoneCode: string;
    zoneName: string;
    vehicleId: number;
    /** Final order of the whole batch. */
    stops: InsertedStop[];
    insertedDispatchIds: number[];
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
    | 'lot_split_by_table_limit'
    | 'zone_deleted';

export interface PlanWarning {
    kind: PlanWarningKind;
    detail: Record<string, unknown>;
}

export interface PlanProposal {
    batches: ProposedBatch[];
    insertions: ProposedInsertion[];
    unplanned: UnplannedDispatch[];
    warnings: PlanWarning[];
}
