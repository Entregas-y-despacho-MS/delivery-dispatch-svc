/**
 * How the two batches look after the customer's rescheduling (ST-224.1, D-32). Pure.
 *
 * The destination takes the route the simulation found (the customer's stop in its place, every other stop in the
 * order and slot the simulation gave it: a notified stop keeps the slot it was told). The origin keeps the order
 * it had and closes the gap. A stop whose place or slot changed is reported, because the batch review reads
 * the version of each dispatch and a change of place must move it (D-09).
 */
import type { SimStopResult } from '../../planning/domain/route-simulation.js';
import { minuteToInstant } from './slot-offer.js';

export interface CurrentStop {
    dispatchId: number;
    sequence: number | null;
    windowStart: Date | null;
}

export interface Placement {
    dispatchId: number;
    sequence: number;
    windowStart: Date;
    windowEnd: Date;
    /** Its place or its slot is not what it was: the dispatch version moves. */
    changed: boolean;
}

export interface DestinationLayout {
    own: Placement;
    others: Placement[];
}

/**
 * `route` is the simulated route of the offer, in visiting order, with the customer's stop in it. `current` is the
 * stops the destination batch has now (without the customer's). Returns `null` when the batch no longer holds
 * exactly the stops the route was simulated with: the offer is stale.
 */
export function layoutDestination(
    route: SimStopResult[],
    ownDispatchId: number,
    shiftDate: string,
    current: CurrentStop[],
): DestinationLayout | null {
    const simulated = new Set(route.map((stop) => stop.id));
    const present = new Set(current.map((stop) => stop.dispatchId));
    if (!simulated.has(ownDispatchId)) return null;
    if (simulated.size - 1 !== present.size || [...present].some((id) => !simulated.has(id))) return null;

    const before = new Map(current.map((stop) => [stop.dispatchId, stop]));
    let own: Placement | null = null;
    const others: Placement[] = [];
    route.forEach((stop, index) => {
        const windowStart = minuteToInstant(shiftDate, stop.window.startMinute);
        const windowEnd = minuteToInstant(shiftDate, stop.window.endMinute);
        const sequence = index + 1;
        if (stop.id === ownDispatchId) {
            own = { dispatchId: stop.id, sequence, windowStart, windowEnd, changed: true };
            return;
        }
        const previous = before.get(stop.id)!;
        const changed = previous.sequence !== sequence || previous.windowStart?.getTime() !== windowStart.getTime();
        others.push({ dispatchId: stop.id, sequence, windowStart, windowEnd, changed });
    });
    return { own: own!, others };
}

export interface OriginPlacement {
    dispatchId: number;
    sequence: number;
    changed: boolean;
}

/** The stops left behind, in their current order, numbered from 1 with no gap. */
export function closeGap(remaining: CurrentStop[]): OriginPlacement[] {
    return [...remaining]
        .sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.dispatchId - b.dispatchId)
        .map((stop, index) => ({ dispatchId: stop.dispatchId, sequence: index + 1, changed: stop.sequence !== index + 1 }));
}
