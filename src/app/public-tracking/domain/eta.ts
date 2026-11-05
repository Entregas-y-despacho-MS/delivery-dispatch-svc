import type { Coordinate } from '../../../plugins/osrm/osrm.port.js';

/** How long an estimate is reused for the same delivery (ST-40.1): the customer's page asks every 30 s. */
export const ETA_CACHE_TTL_SECONDS = 60;

/**
 * The points OSRM has to drive through: where the driver is, each pending stop before this order (in visiting
 * order) and the customer's address, last. Stops without coordinates cannot be routed and are skipped.
 */
export function buildEtaPath(
    driver: Coordinate,
    previousStops: ReadonlyArray<Coordinate | null>,
    destination: Coordinate,
): Coordinate[] {
    const stops = previousStops.filter((stop): stop is Coordinate => stop !== null);
    return [driver, ...stops, destination];
}

/**
 * Driving seconds of the whole path from a duration matrix of its points: the sum of each point to the next one.
 * `null` when any leg has no route, because then there is no honest total.
 */
export function pathSeconds(durations: ReadonlyArray<ReadonlyArray<number | null>>, points: number): number | null {
    let total = 0;
    for (let i = 0; i < points - 1; i++) {
        const leg = durations[i]?.[i + 1];
        if (leg === null || leg === undefined || !Number.isFinite(leg) || leg < 0) return null;
        total += leg;
    }
    return total;
}

/** Whole minutes, rounded up: 61 s is "2 min", never "1 min" (the customer must not be told less than the truth). */
export function secondsToMinutes(seconds: number): number {
    return Math.ceil(seconds / 60);
}

/** The promised slot in place of an estimate: minutes until it ends, never negative. `null` when there is no slot. */
export function minutesToWindowEnd(windowEnd: Date | null, now: Date): number | null {
    if (windowEnd === null) return null;
    return Math.max(0, Math.ceil((windowEnd.getTime() - now.getTime()) / 60_000));
}
