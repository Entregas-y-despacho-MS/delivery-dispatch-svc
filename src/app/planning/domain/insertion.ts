/**
 * Cheapest feasible insertion of a stop into a route (ST-50.2, plan §2.7). Pure.
 *
 * Every position of the route is tried by simulating the whole sequence; a position is kept only if
 * the route stays feasible, which means no already notified stop leaves its window and the route
 * ends before the afternoon window does. The cost is the extra driving time (without margin or
 * service), ties go to the earliest position.
 */
import { drivingSeconds, simulateRoute, type SimParams, type SimResult, type SimStop } from './route-simulation.js';

export interface InsertionChoice {
    /** 0-based index in the sequence the stop is inserted at. */
    position: number;
    /** Extra driving seconds the stop adds. */
    costSeconds: number;
    simulation: SimResult;
}

export function findCheapestInsertion(existing: SimStop[], candidate: SimStop, params: SimParams): InsertionChoice | null {
    const baseSeconds = drivingSeconds(existing.map((stop) => stop.id), params.travelSeconds) ?? 0;

    let best: InsertionChoice | null = null;
    for (let position = 0; position <= existing.length; position++) {
        const sequence = [...existing.slice(0, position), candidate, ...existing.slice(position)];
        const simulation = simulateRoute(sequence, params);
        if (!simulation.feasible) continue;

        const total = drivingSeconds(sequence.map((stop) => stop.id), params.travelSeconds);
        if (total === null) continue;

        const costSeconds = total - baseSeconds;
        if (best === null || costSeconds < best.costSeconds) best = { position, costSeconds, simulation };
    }
    return best;
}

export interface InsertionOption extends InsertionChoice {
    /** The slot the inserted stop gets in this position (minutes since local midnight). */
    window: { startMinute: number; endMinute: number };
}

/**
 * Every slot the stop can get in a route, with the cheapest feasible position for each one (ST-224.1).
 *
 * `findCheapestInsertion` answers one position; a customer who is choosing a new slot needs the whole menu:
 * the morning and the afternoon of the same batch can both work, at different positions. Each feasible
 * position is simulated as a whole sequence (so a notified stop never leaves its window), the stop's slot is
 * read from the simulation, and for each distinct slot the cheapest position is kept (ties: the earliest).
 * Sorted by slot start.
 */
export function findInsertionOptions(existing: SimStop[], candidate: SimStop, params: SimParams): InsertionOption[] {
    const baseSeconds = drivingSeconds(existing.map((stop) => stop.id), params.travelSeconds) ?? 0;

    const bySlot = new Map<string, InsertionOption>();
    for (let position = 0; position <= existing.length; position++) {
        const sequence = [...existing.slice(0, position), candidate, ...existing.slice(position)];
        const simulation = simulateRoute(sequence, params);
        if (!simulation.feasible) continue;

        const total = drivingSeconds(sequence.map((stop) => stop.id), params.travelSeconds);
        const window = simulation.stops.find((stop) => stop.id === candidate.id)?.window;
        if (total === null || !window) continue;

        const key = `${window.startMinute}-${window.endMinute}`;
        const costSeconds = total - baseSeconds;
        const kept = bySlot.get(key);
        if (!kept || costSeconds < kept.costSeconds) bySlot.set(key, { position, costSeconds, simulation, window });
    }
    return [...bySlot.values()].sort((a, b) => a.window.startMinute - b.window.startMinute);
}

export interface SequenceResult {
    /** The stops that fit, in visiting order. */
    sequence: SimStop[];
    simulation: SimResult;
    /** Stops that fit no position, in the order they were offered. */
    rejected: SimStop[];
}

/** Builds a route from scratch, offering the stops in the given order (fixed windows first). */
export function sequenceByInsertion(stops: SimStop[], params: SimParams): SequenceResult {
    let sequence: SimStop[] = [];
    const rejected: SimStop[] = [];
    for (const stop of stops) {
        const choice = findCheapestInsertion(sequence, stop, params);
        if (!choice) {
            rejected.push(stop);
            continue;
        }
        sequence = [...sequence.slice(0, choice.position), stop, ...sequence.slice(choice.position)];
    }
    return { sequence, simulation: simulateRoute(sequence, params), rejected };
}
