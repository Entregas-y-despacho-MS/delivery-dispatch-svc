import { FIRST_ATTEMPT_COVERAGE_INCOMPLETE_REASON, FIRST_ATTEMPT_DATE_BASIS, FIRST_ATTEMPT_UNAVAILABLE_REASON } from './otd-basis.js';
import { percentage } from './percentage.js';
import type { FirstAttemptDto } from '../dto/otd-report.dto.js';

/**
 * Delivery attempts rebuilt from the status events of a dispatch (ST-301.3). There is no attempts table: the attempt is
 * derived on read, so repeating an event cannot add a row.
 *
 * - **An attempt** is a trip to a stop that ends in a result: `delivered`, an entry into `not_delivered`, or an `incident`
 *   whose reason consumes an attempt (D-48). The event that starts it is the change to `in_transit`.
 * - **Correlation.** Results with no `in_transit` between them are the same attempt: a `not_delivered` and the incident
 *   that caused it count once. The first result is the one that stands.
 * - **Idempotency.** A result only opens an attempt if a trip started after the previous one, so a repeated event (the same
 *   status written again, or a retry) adds nothing. The attempt's id is the event's `client_event_id` when the device sent
 *   one (the unique index already stops a retry), else its `dispatch_event_id`.
 * - **Not rebuildable.** A first result with no `in_transit` before it cannot be told apart from an old event written
 *   before the instrumentation: the dispatch is `reconstructable = false` and exposes no attempt. The same goes for a
 *   dispatch that already ended `delivered` or `not_delivered` but has no attempt at all (its events were never written).
 *
 * This is NOT the rule of `max_delivery_attempts` (`DeliveryAttemptsService`, A-9): that one limits retries, this one measures.
 */

export const IN_TRANSIT = 'in_transit';

/** One `status_changed` event of a dispatch, as the query reads it (the status already resolved from `status` or `to`). */
export interface AttemptEvent {
    eventId: number;
    clientEventId: string | null;
    occurredAt: Date;
    previousStatus: string | null;
    status: string | null;
    /** Only for `incident`: its reason has `counts_as_attempt = TRUE`. */
    countsAsAttempt: boolean;
}

export enum AttemptOutcome {
    DELIVERED     = 'delivered',
    NOT_DELIVERED = 'not_delivered',
    INCIDENT      = 'incident',
}

export interface NormalizedAttempt {
    attemptId: string;
    /** 1 is the first attempt. */
    order: number;
    outcome: AttemptOutcome;
    occurredAt: Date;
    /**
     * The incidents that consume an attempt and belong to this one (ST-300.1): the one that is its result, or the ones that came
     * after it in the same trip (an incident after a `not_delivered`, a second incident). Same key as `attemptId`: the event's
     * `client_event_id` (the incident id) or `event-<id>`. A repeated event is listed once.
     */
    incidentKeys: string[];
}

export interface DispatchAttempts {
    attempts: NormalizedAttempt[];
    reconstructable: boolean;
}

function outcomeOf(event: AttemptEvent): AttemptOutcome | null {
    if (event.status === AttemptOutcome.DELIVERED) return AttemptOutcome.DELIVERED;
    if (event.status === AttemptOutcome.NOT_DELIVERED) return AttemptOutcome.NOT_DELIVERED;
    if (event.status === AttemptOutcome.INCIDENT && event.countsAsAttempt) return AttemptOutcome.INCIDENT;
    return null;
}

export function normalizeAttempts(events: AttemptEvent[]): DispatchAttempts {
    const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.eventId - b.eventId);
    const attempts: NormalizedAttempt[] = [];
    let reconstructable = true;
    let tripStarted = false;

    for (const event of ordered) {
        if (!event.status) continue;
        if (event.status === IN_TRANSIT) {
            tripStarted = true;
            continue;
        }
        const outcome = outcomeOf(event);
        if (!outcome) continue;
        const key = event.clientEventId ?? `event-${event.eventId}`;
        if (!tripStarted) {
            if (attempts.length === 0) reconstructable = false;
            else if (outcome === AttemptOutcome.INCIDENT) {
                // An incident of the same trip as the last attempt (the one that caused a `not_delivered`, or a second one): it is that attempt, not a new one.
                const last = attempts[attempts.length - 1];
                if (last.outcome !== AttemptOutcome.DELIVERED && !last.incidentKeys.includes(key)) last.incidentKeys.push(key);
            }
            continue;
        }
        attempts.push({
            attemptId: key, order: attempts.length + 1, outcome, occurredAt: event.occurredAt,
            incidentKeys: outcome === AttemptOutcome.INCIDENT ? [key] : [],
        });
        tripStarted = false;
    }
    return reconstructable ? { attempts, reconstructable } : { attempts: [], reconstructable };
}

export enum FirstAttemptResult {
    ON_TIME             = 'on_time',
    LATE                = 'late',
    DELIVERED_NO_WINDOW = 'delivered_no_window',
    FAILED              = 'failed',
    NO_ATTEMPT_YET      = 'no_attempt_yet',
    NOT_RECONSTRUCTABLE = 'not_reconstructable',
}

export interface CommittedWindow {
    start: Date | null;
    end: Date | null;
}

/** A dispatch in one of these statuses has had its result: with no attempt rebuilt, it is history we cannot read, not «not yet». */
const RESULT_STATUSES: ReadonlySet<string> = new Set([AttemptOutcome.DELIVERED, AttemptOutcome.NOT_DELIVERED]);

/** The first attempt of a dispatch against the window in force (both ends included, as the OTD measures it). `status` is its current status. */
export function classifyFirstAttempt(history: DispatchAttempts, window: CommittedWindow, status: string): FirstAttemptResult {
    if (!history.reconstructable) return FirstAttemptResult.NOT_RECONSTRUCTABLE;
    const first = history.attempts[0];
    if (!first) return RESULT_STATUSES.has(status) ? FirstAttemptResult.NOT_RECONSTRUCTABLE : FirstAttemptResult.NO_ATTEMPT_YET;
    if (first.outcome !== AttemptOutcome.DELIVERED) return FirstAttemptResult.FAILED;
    const { start, end } = window;
    if (!start || !end || end.getTime() < start.getTime()) return FirstAttemptResult.DELIVERED_NO_WINDOW;
    const at = first.occurredAt.getTime();
    return at >= start.getTime() && at <= end.getTime() ? FirstAttemptResult.ON_TIME : FirstAttemptResult.LATE;
}

/** What the range looks like against the instrumented period. */
export interface AttemptCoverage {
    from: Date | null;
    complete: boolean;
}

/** The whole range is covered only when it starts on or after the first instrumented event; with none, nothing is covered. */
export function attemptCoverage(rangeStart: Date, firstInstrumentedAt: Date | null): AttemptCoverage {
    return { from: firstInstrumentedAt, complete: firstInstrumentedAt !== null && rangeStart.getTime() >= firstInstrumentedAt.getTime() };
}

export type FirstAttemptCounts = Record<'onTime' | 'late' | 'deliveredNoWindow' | 'failed' | 'noAttemptYet' | 'notReconstructable', number>;

export function tallyFirstAttempts(results: FirstAttemptResult[]): FirstAttemptCounts {
    const counts: FirstAttemptCounts = { onTime: 0, late: 0, deliveredNoWindow: 0, failed: 0, noAttemptYet: 0, notReconstructable: 0 };
    const key: Record<FirstAttemptResult, keyof FirstAttemptCounts> = {
        [FirstAttemptResult.ON_TIME]: 'onTime',
        [FirstAttemptResult.LATE]: 'late',
        [FirstAttemptResult.DELIVERED_NO_WINDOW]: 'deliveredNoWindow',
        [FirstAttemptResult.FAILED]: 'failed',
        [FirstAttemptResult.NO_ATTEMPT_YET]: 'noAttemptYet',
        [FirstAttemptResult.NOT_RECONSTRUCTABLE]: 'notReconstructable',
    };
    for (const result of results) counts[key[result]] += 1;
    return counts;
}

/**
 * The first-attempt block. Numerator = first attempt delivered (on time or late); denominator = first attempts that
 * already happened and could be rebuilt. With an incomplete coverage the rate is N/D (`available: false`) but the counts
 * are still shown; with a denominator of 0 it is «Sin datos» (`available: true`, `percentage: null`).
 */
export function buildFirstAttempt(counts: FirstAttemptCounts, coverage: AttemptCoverage): FirstAttemptDto {
    const numerator = counts.onTime + counts.late + counts.deliveredNoWindow;
    const denominator = numerator + counts.failed;
    return {
        available: coverage.complete,
        reason: coverage.complete ? null : FIRST_ATTEMPT_COVERAGE_INCOMPLETE_REASON,
        numerator,
        denominator,
        n: denominator,
        percentage: coverage.complete ? percentage(numerator, denominator) : null,
        dateBasis: FIRST_ATTEMPT_DATE_BASIS,
        onTimeCount: counts.onTime,
        lateCount: counts.late,
        deliveredWithoutWindowCount: counts.deliveredNoWindow,
        failedCount: counts.failed,
        noAttemptYetCount: counts.noAttemptYet,
        notReconstructableCount: counts.notReconstructable,
        coverage: { from: coverage.from ? coverage.from.toISOString() : null, complete: coverage.complete },
    };
}

/** The block while the attempts have not been read: N/D with every count at 0. */
export function unavailableFirstAttempt(): FirstAttemptDto {
    return {
        ...buildFirstAttempt(tallyFirstAttempts([]), { from: null, complete: false }),
        reason: FIRST_ATTEMPT_UNAVAILABLE_REASON,
    };
}

/** What the open overdue list shows of a dispatch: how many valid attempts it has used (null if they cannot be rebuilt) and how its first one went. */
export interface DispatchAttemptSummary {
    attemptsUsed: number | null;
    firstAttemptResult: FirstAttemptResult;
}

export function summarizeAttempts(events: AttemptEvent[], window: CommittedWindow, status: string): DispatchAttemptSummary {
    const history = normalizeAttempts(events);
    const firstAttemptResult = classifyFirstAttempt(history, window, status);
    return { attemptsUsed: firstAttemptResult === FirstAttemptResult.NOT_RECONSTRUCTABLE ? null : history.attempts.length, firstAttemptResult };
}
