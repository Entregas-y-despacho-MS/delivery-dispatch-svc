/**
 * Splits one group of orders (same day, zone and warehouse) into batches, one vehicle each (ST-50.2,
 * D-21): the group goes to the smallest free vehicle where it fits; when it fits none, it is divided
 * by proximity. The same split is used when a batch would exceed the `table` request limit.
 *
 * Pure: it works over a duration matrix whose index 0 is the depot and index i + 1 is `dispatches[i]`.
 */
import type { PlanDispatch, PlanVehicle } from './plan-types.js';
import { bySmallestVehicle, fitsVehicle } from './vehicle-selection.js';

export interface DurationLookup {
    /** Seconds from matrix index `from` to `to`, or `null` when there is no route. */
    (from: number, to: number): number | null;
}

export interface ComposedBatch {
    /** Dispatches of the batch in visiting order. */
    dispatches: PlanDispatch[];
    vehicle: PlanVehicle;
    /** Larger free vehicles that also fit this batch, smallest first. */
    alternativeVehicles: PlanVehicle[];
}

export interface Composition {
    batches: ComposedBatch[];
    /** Orders that fit no vehicle of the whole fleet: not even alone. */
    unfittable: PlanDispatch[];
    /** Orders that fit a vehicle but no free vehicle was left for them. */
    withoutVehicle: PlanDispatch[];
    /** Set when the group did not go into one batch. */
    splitReason: 'capacity' | 'table_limit' | null;
}

/**
 * Nearest-neighbour chain from `from` (the depot by default) over `indexes` (matrix indexes). Unreachable pairs are
 * treated as infinitely far; if everything left is unreachable the rest keeps its input order.
 */
export function nearestNeighbourChain(indexes: number[], duration: DurationLookup, from = 0): number[] {
    const remaining = [...indexes];
    const chain: number[] = [];
    let current = from;
    while (remaining.length > 0) {
        let best = 0;
        let bestCost = Number.POSITIVE_INFINITY;
        for (let i = 0; i < remaining.length; i++) {
            const cost = duration(current, remaining[i]) ?? Number.POSITIVE_INFINITY;
            if (cost < bestCost) {
                bestCost = cost;
                best = i;
            }
        }
        current = remaining.splice(best, 1)[0];
        chain.push(current);
    }
    return chain;
}

/**
 * @param dispatches the group, in queue order; matrix index of `dispatches[i]` is `i + 1`
 * @param freeVehicles vehicles not used that day (any order)
 * @param allVehicles the whole fleet, to tell "does not fit anything" from "no vehicle left"
 * @param maxStops most stops one batch may have (`table` limit − 1)
 */
export function composeBatches(
    dispatches: PlanDispatch[],
    duration: DurationLookup,
    freeVehicles: PlanVehicle[],
    allVehicles: PlanVehicle[],
    maxStops: number,
): Composition {
    const byIndex = new Map(dispatches.map((dispatch, i) => [i + 1, dispatch]));
    const free = [...freeVehicles].sort(bySmallestVehicle);
    const fleet = [...allVehicles].sort(bySmallestVehicle);
    const largestOfFleet = fleet[fleet.length - 1];

    const unfittable: PlanDispatch[] = [];
    const placeable: number[] = [];
    for (const [index, dispatch] of byIndex) {
        if (largestOfFleet && fleet.some((vehicle) => fitsVehicle([dispatch], vehicle))) placeable.push(index);
        else unfittable.push(dispatch);
    }

    const largestFreeAtStart = free[free.length - 1];
    const placeableDispatches = placeable.map((index) => byIndex.get(index)!);
    const fitsOneBatch = largestFreeAtStart !== undefined
        && placeable.length <= maxStops
        && fitsVehicle(placeableDispatches, largestFreeAtStart);

    // One batch: visit in nearest-neighbour order from the depot. Several batches: the first one starts
    // with the head of the queue (urgent orders first, D-15/D-16) and takes its nearest neighbours, so
    // the priority decides who gets the vehicles that exist.
    const chain = fitsOneBatch || placeable.length === 0
        ? nearestNeighbourChain(placeable, duration)
        : [placeable[0], ...nearestNeighbourChain(placeable.slice(1), duration, placeable[0])];

    const batches: ComposedBatch[] = [];
    // Orders that fit a vehicle of the fleet that is already taken today: they wait for another day.
    const skipped: number[] = [];
    let remaining = chain;
    while (remaining.length > 0 && free.length > 0) {
        const largestFree = free[free.length - 1];
        const segment: number[] = [];
        for (const index of remaining) {
            const candidate = [...segment, index].map((i) => byIndex.get(i)!);
            if (candidate.length > maxStops || !fitsVehicle(candidate, largestFree)) break;
            segment.push(index);
        }
        if (segment.length === 0) {
            skipped.push(remaining[0]);
            remaining = remaining.slice(1);
            continue;
        }

        const members = segment.map((index) => byIndex.get(index)!);
        const [vehicle, ...alternativeVehicles] = free.filter((candidate) => fitsVehicle(members, candidate));
        free.splice(free.indexOf(vehicle), 1);
        // Visiting order of the batch: nearest neighbour from the depot over its own orders.
        const visiting = nearestNeighbourChain(segment, duration).map((index) => byIndex.get(index)!);
        batches.push({ dispatches: visiting, vehicle, alternativeVehicles });
        remaining = remaining.slice(segment.length);
    }

    const withoutVehicle = [...skipped, ...remaining].map((index) => byIndex.get(index)!);

    let splitReason: Composition['splitReason'] = null;
    if (batches.length > 1 || (batches.length === 1 && withoutVehicle.length > 0)) {
        // "table_limit": the group would have fitted the biggest free vehicle if it were not for the
        // number of stops; otherwise it is the capacity that forced the split.
        const onlyStopsExceeded = largestFreeAtStart !== undefined
            && placeable.length > maxStops
            && fitsVehicle(placeableDispatches, largestFreeAtStart);
        splitReason = onlyStopsExceeded ? 'table_limit' : 'capacity';
    }

    return { batches, unfittable, withoutVehicle, splitReason };
}
