/**
 * Which stops of a provisional batch enter the D-1 cutoff (ST-51.3). Pure.
 *
 * Only a promise that is firm, or whose response window already closed, is something the company
 * can plan around. The window is recomputed here with the same formula as the closing task
 * (ST-215.4) instead of trusting `promise_firmed_at`: the task runs every few minutes, so a stop whose
 * 12 h ended a moment ago may not be firmed yet and must still enter.
 */
import type { CutoffEligibility, CutoffStop } from './cutoff-types.js';

export function classifyStop(stop: CutoffStop, now: Date, windowMinutes: number): CutoffEligibility {
    if (stop.promiseFirmedAt) return 'firm';
    // Never approved: the customer was told nothing, so there is no promise to keep (§5.3).
    if (stop.dispatch.status !== 'scheduled') return 'no_promise';
    // Approved but no valid notice yet (the email bounced): the customer's clock never started.
    if (!stop.promiseNotifiedAt) return 'window_open';
    const windowEnd = stop.promiseNotifiedAt.getTime() + windowMinutes * 60_000;
    return windowEnd <= now.getTime() ? 'window_elapsed' : 'window_open';
}

export function entersCutoff(eligibility: CutoffEligibility): boolean {
    return eligibility === 'firm' || eligibility === 'window_elapsed';
}

export interface PartitionedStops {
    /** Enter the cutoff. */
    eligible: CutoffStop[];
    /** Promised but still answerable: wait in a remnant batch. */
    open: CutoffStop[];
    /** Never approved: leave the batch and go back to `pending`. */
    withoutPromise: CutoffStop[];
}

export function partitionStops(stops: CutoffStop[], now: Date, windowMinutes: number): PartitionedStops {
    const result: PartitionedStops = { eligible: [], open: [], withoutPromise: [] };
    for (const stop of stops) {
        const eligibility = classifyStop(stop, now, windowMinutes);
        if (entersCutoff(eligibility)) result.eligible.push(stop);
        else if (eligibility === 'window_open') result.open.push(stop);
        else result.withoutPromise.push(stop);
    }
    return result;
}
