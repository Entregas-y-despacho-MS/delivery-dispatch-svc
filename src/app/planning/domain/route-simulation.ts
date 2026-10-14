/**
 * Simulates a route to decide whether a sequence of stops is feasible and which slot each one gets
 * (ST-50.2, plan §2.5). Pure: minutes since local midnight, travel times in seconds from OSRM.
 *
 *   arrival_k  = departure_{k-1} + travel(k-1 → k) × (1 + planning_margin_pct / 100)
 *   start_k    = max(arrival_k, slot start)                 (waits if it arrives early)
 *   feasible_k ⇔ arrival_k ≤ slot end                       ("arrival plus margin does not pass the slot")
 *   departure_k = start_k + stop_service_minutes
 *   route ok   ⇔ every stop feasible ∧ last departure ≤ afternoon_window_end   (the way back is not counted)
 *
 * The route leaves the depot at `routeStartMinute` (morning_window_start). A stop that was already
 * notified to the customer has a fixed window that never moves (D-10); any other stop takes the first
 * slot whose end is not before its arrival.
 */
import { slotForArrival, type TimeSlot } from './time-slots.js';

export interface SimStop {
    /** dispatch id */
    id: number;
    /** Window promised to the customer; `null` when the stop can still be given any slot. */
    fixedWindow: { startMinute: number; endMinute: number } | null;
}

/** Seconds from `from` (a dispatch id, or `null` for the depot) to `to`; `null` when there is no route. */
export type TravelSeconds = (from: number | null, to: number) => number | null;

export interface SimParams {
    slots: TimeSlot[];
    routeStartMinute: number;
    routeEndMinute: number;
    serviceMinutes: number;
    marginPct: number;
    travelSeconds: TravelSeconds;
}

export interface SimStopResult {
    id: number;
    arrivalMinute: number;
    startMinute: number;
    departureMinute: number;
    /** The fixed window, or the slot derived for the stop. */
    window: { startMinute: number; endMinute: number };
    fixed: boolean;
}

export type SimFailure = 'no_route' | 'late_for_window' | 'no_slot' | 'route_too_long';

export interface SimResult {
    feasible: boolean;
    stops: SimStopResult[];
    /** Minute the last stop is left, or the start when there are no stops. */
    endMinute: number;
    failedStopId: number | null;
    failure: SimFailure | null;
}

export function simulateRoute(stops: SimStop[], params: SimParams): SimResult {
    const results: SimStopResult[] = [];
    let clock = params.routeStartMinute;
    let previous: number | null = null;

    for (const stop of stops) {
        const seconds = params.travelSeconds(previous, stop.id);
        if (seconds === null) return fail(results, clock, stop.id, 'no_route');

        const arrival = clock + (seconds / 60) * (1 + params.marginPct / 100);
        let window: { startMinute: number; endMinute: number };
        if (stop.fixedWindow) {
            window = stop.fixedWindow;
            if (arrival > window.endMinute) return fail(results, clock, stop.id, 'late_for_window');
        } else {
            const slot = slotForArrival(params.slots, arrival);
            if (!slot) return fail(results, clock, stop.id, 'no_slot');
            window = { startMinute: slot.startMinute, endMinute: slot.endMinute };
        }

        const start = Math.max(arrival, window.startMinute);
        clock = start + params.serviceMinutes;
        previous = stop.id;
        results.push({
            id: stop.id,
            arrivalMinute: arrival,
            startMinute: start,
            departureMinute: clock,
            window,
            fixed: stop.fixedWindow !== null,
        });
    }

    if (clock > params.routeEndMinute) {
        return { feasible: false, stops: results, endMinute: clock, failedStopId: stops.at(-1)?.id ?? null, failure: 'route_too_long' };
    }
    return { feasible: true, stops: results, endMinute: clock, failedStopId: null, failure: null };
}

function fail(stops: SimStopResult[], clock: number, stopId: number, failure: SimFailure): SimResult {
    return { feasible: false, stops, endMinute: clock, failedStopId: stopId, failure };
}

/** Pure driving time of a sequence from the depot, without margin or service; `null` if a leg has no route. */
export function drivingSeconds(ids: number[], travelSeconds: TravelSeconds): number | null {
    let total = 0;
    let previous: number | null = null;
    for (const id of ids) {
        const seconds = travelSeconds(previous, id);
        if (seconds === null) return null;
        total += seconds;
        previous = id;
    }
    return total;
}
