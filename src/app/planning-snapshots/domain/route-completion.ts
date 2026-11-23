/**
 * Completion of the stops of a route, measured on its frozen manifests (ST-302.2, ES-302, rule 6 of the HU). Pure.
 *
 * The baseline is the union of the first `confirmed` manifest and the `started` one: every stop the coordinator
 * confirmed, plus any that joined before the route left. Each stop falls in exactly one category, so deliveries,
 * pickups, a cancellation before the start and an unsuccessful result never add into one number. The outcome comes
 * from the current dispatch, the baseline never moves, so the same manifest gives the same denominator while the
 * route advances and each stop shows its result without waiting for the batch to close.
 */
import { classifyRemovedBeforeStart, classifyStopOutcome, type StopOutcome } from './stop-outcome.js';

export interface BaselineStop {
    dispatchId: number;
    dispatchType: string;
    /** Current `dispatch_statuses.name`. */
    currentStatus: string;
    sequenceOrder: number | null;
    /** State in the `started` manifest; `null` when the stop was in the confirmed manifest but not in the started one. */
    startedState: 'departing' | 'excluded' | null;
}

export interface BaselineStopResult extends BaselineStop {
    outcome: StopOutcome;
}

export type OutcomeCounts = Record<StopOutcome, number>;

export interface RouteCompletion {
    /** Every stop of the baseline, in visiting order. */
    stops: BaselineStopResult[];
    counts: OutcomeCounts;
    /** Stops that left with the route (`departing` in the started manifest). */
    departed: number;
    /** Departed stops that already have a result (delivered, pickup completed or unsuccessful). */
    finalized: number;
    /** `finalized / departed` in percent with two decimals; `null` when nothing departed. */
    finalizedPct: number | null;
}

export const OUTCOMES: readonly StopOutcome[] = [
    'delivered',
    'pickup_completed',
    'unsuccessful',
    'pending',
    'excluded_at_start',
    'cancelled_before_start',
    'removed_before_start',
];

export function emptyCounts(): OutcomeCounts {
    return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as OutcomeCounts;
}

export function sumCounts(parts: readonly OutcomeCounts[]): OutcomeCounts {
    const total = emptyCounts();
    for (const part of parts) for (const outcome of OUTCOMES) total[outcome] += part[outcome];
    return total;
}

export function finalizedOf(counts: OutcomeCounts): number {
    return counts.delivered + counts.pickup_completed + counts.unsuccessful;
}

export function departedOf(counts: OutcomeCounts): number {
    return counts.delivered + counts.pickup_completed + counts.unsuccessful + counts.pending;
}

export function percentOf(part: number, whole: number): number | null {
    return whole === 0 ? null : Math.round((part / whole) * 10000) / 100;
}

export function summarizeRoute(stops: readonly BaselineStop[]): RouteCompletion {
    const results: BaselineStopResult[] = [...stops]
        .sort((a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER) || a.dispatchId - b.dispatchId)
        .map((stop) => ({
            ...stop,
            outcome:
                stop.startedState === null
                    ? classifyRemovedBeforeStart(stop.currentStatus)
                    : classifyStopOutcome({ stopState: stop.startedState, dispatchType: stop.dispatchType, dispatchStatus: stop.currentStatus }),
        }));
    const counts = emptyCounts();
    for (const result of results) counts[result.outcome] += 1;
    const departed = departedOf(counts);
    const finalized = finalizedOf(counts);
    return { stops: results, counts, departed, finalized, finalizedPct: percentOf(finalized, departed) };
}
