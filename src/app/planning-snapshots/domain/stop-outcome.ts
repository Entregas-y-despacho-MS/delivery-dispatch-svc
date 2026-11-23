/**
 * Where a stop of a frozen manifest stands now (ST-302.2, ES-302, rule 6 of the HU). Pure.
 *
 * The manifest is the baseline and never changes; the outcome is read from the dispatch as it is today. Deliveries,
 * pickups, a cancellation before the route left and an unsuccessful result are kept apart, so the dashboard never
 * adds them into one number. The mapping of statuses is one decision in one place: change it here, not in a query.
 */
export type StopOutcome =
    /** A delivery that reached `delivered`. */
    | 'delivered'
    /** A pickup that was collected. */
    | 'pickup_completed'
    /** The route left and the stop ended without the expected result (not delivered, incident, returned, rescheduled, cancelled on the way). */
    | 'unsuccessful'
    /** The route left and the stop is still open. */
    | 'pending'
    /** It did not leave: excluded at the start (for example a failed package check). */
    | 'excluded_at_start'
    /** It was in the confirmed route, never left, and the order was cancelled. */
    | 'cancelled_before_start'
    /** It was in the confirmed route and never left, but it was not cancelled (it was rescheduled or moved out of the batch). */
    | 'removed_before_start';

const PICKUP_TYPES: ReadonlySet<string> = new Set(['supplier_pickup', 'warehouse_return_pickup']);

/** Statuses in which a stop that left did not end as expected. */
const UNSUCCESSFUL_STATUSES: ReadonlySet<string> = new Set([
    'not_delivered',
    'incident',
    'returned',
    'returned_to_warehouse',
    'rescheduled',
    'cancelled',
]);

/**
 * A pickup is done once it was collected; `delivered` is accepted too because a pickup that reaches the warehouse can
 * close that way. To confirm against the real pickup flow when the completion query is built (ST-302.2, stage 4).
 */
const PICKUP_COMPLETED_STATUSES: ReadonlySet<string> = new Set(['picked_up_in_transit', 'returned_to_warehouse', 'delivered']);

export function isPickupType(dispatchType: string): boolean {
    return PICKUP_TYPES.has(dispatchType);
}

export interface BaselineStop {
    /** State of the stop in the `started` manifest. */
    stopState: 'departing' | 'excluded';
    dispatchType: string;
    /** Current `dispatch_statuses.name`. */
    dispatchStatus: string;
}

/** Outcome of a stop that is in the `started` manifest. */
export function classifyStopOutcome(stop: BaselineStop): StopOutcome {
    if (stop.stopState === 'excluded') return 'excluded_at_start';
    if (isPickupType(stop.dispatchType)) {
        // A pickup that returned to the warehouse was collected; for a delivery the same status is a failed one.
        if (PICKUP_COMPLETED_STATUSES.has(stop.dispatchStatus)) return 'pickup_completed';
        return UNSUCCESSFUL_STATUSES.has(stop.dispatchStatus) ? 'unsuccessful' : 'pending';
    }
    if (stop.dispatchStatus === 'delivered') return 'delivered';
    return UNSUCCESSFUL_STATUSES.has(stop.dispatchStatus) ? 'unsuccessful' : 'pending';
}

/** Outcome of a stop that was in the `confirmed` manifest but is not in the `started` one. */
export function classifyRemovedBeforeStart(dispatchStatus: string): 'cancelled_before_start' | 'removed_before_start' {
    return dispatchStatus === 'cancelled' ? 'cancelled_before_start' : 'removed_before_start';
}
