import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { TERMINAL_DISPATCH_STATUSES } from '../../../modules/dispatch/dispatches/utils/terminal-statuses.js';

/**
 * The mutually exclusive buckets of the operational summary (ST-301.1). A dispatch is counted by its own `dispatchId`
 * and status, never by the status of its batch: one delivered inside a batch still `in_execution` is `delivered`.
 * Terminal buckets are never added to the backlog (`open_overdue` + `pending`).
 */
export enum BacklogBucket {
    DELIVERED     = 'delivered',
    /** Active (not finished) and its promise already expired. */
    OPEN_OVERDUE  = 'open_overdue',
    /** Active and its promise has not expired (or has no valid window). */
    PENDING       = 'pending',
    NOT_DELIVERED = 'not_delivered',
    RESCHEDULED   = 'rescheduled',
    CANCELLED     = 'cancelled',
    /** `returned` and `returned_to_warehouse`. */
    RETURNED      = 'returned',
}

/** Active = neither finished nor waiting for a new window: the stages a dispatch crosses until it is delivered. */
export const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatusEnum[] = Object.values(DispatchStatusEnum).filter(
    (status) => !TERMINAL_DISPATCH_STATUSES.includes(status) && status !== DispatchStatusEnum.RESCHEDULED,
);

export function isActiveDispatchStatus(status: string): boolean {
    return (ACTIVE_DISPATCH_STATUSES as readonly string[]).includes(status);
}

/** The bucket of one dispatch. `overdue` only matters for an active one. An unknown status is a bug, not a bucket. */
export function bucketOf(status: string, overdue: boolean): BacklogBucket {
    switch (status) {
        case DispatchStatusEnum.DELIVERED:
            return BacklogBucket.DELIVERED;
        case DispatchStatusEnum.NOT_DELIVERED:
            return BacklogBucket.NOT_DELIVERED;
        case DispatchStatusEnum.RESCHEDULED:
            return BacklogBucket.RESCHEDULED;
        case DispatchStatusEnum.CANCELLED:
            return BacklogBucket.CANCELLED;
        case DispatchStatusEnum.RETURNED:
        case DispatchStatusEnum.RETURNED_TO_WAREHOUSE:
            return BacklogBucket.RETURNED;
        default:
            if (!isActiveDispatchStatus(status)) throw new RangeError(`Unknown dispatch status: ${status}`);
            return overdue ? BacklogBucket.OPEN_OVERDUE : BacklogBucket.PENDING;
    }
}

/** How long a dispatch has been in its current stage. */
export enum AgeRange {
    UNDER_1_DAY   = 'under_1d',
    ONE_TO_3_DAYS = '1d_to_3d',
    OVER_3_DAYS   = 'over_3d',
}

const MINUTES_PER_DAY = 1_440;

/** Upper bounds are exclusive; the last range has none. */
export const AGE_RANGE_BOUNDS: ReadonlyArray<{ range: AgeRange; maxMinutesExclusive: number | null }> = [
    { range: AgeRange.UNDER_1_DAY,   maxMinutesExclusive: MINUTES_PER_DAY },
    { range: AgeRange.ONE_TO_3_DAYS, maxMinutesExclusive: 3 * MINUTES_PER_DAY },
    { range: AgeRange.OVER_3_DAYS,   maxMinutesExclusive: null },
];

/** A negative age (a wrong clock) falls in the youngest range. */
export function ageRangeOf(minutes: number): AgeRange {
    for (const { range, maxMinutesExclusive } of AGE_RANGE_BOUNDS) {
        if (maxMinutesExclusive === null || minutes < maxMinutesExclusive) return range;
    }
    return AgeRange.OVER_3_DAYS;
}

/** What the coordinator has to do next with an open dispatch, derived from the stage it is stuck in. */
export enum NextAction {
    REVIEW_ADDRESS   = 'review_address',
    PLAN             = 'plan',
    ASSIGN_ROUTE     = 'assign_route',
    START_ROUTE      = 'start_route',
    FOLLOW_DELIVERY  = 'follow_delivery',
    RESOLVE_INCIDENT = 'resolve_incident',
}

const NEXT_ACTION_BY_STATUS: Readonly<Record<string, NextAction>> = {
    [DispatchStatusEnum.ADDRESS_REVIEW]:       NextAction.REVIEW_ADDRESS,
    [DispatchStatusEnum.PENDING]:              NextAction.PLAN,
    [DispatchStatusEnum.IN_PLANNING]:          NextAction.PLAN,
    [DispatchStatusEnum.SCHEDULED]:            NextAction.ASSIGN_ROUTE,
    [DispatchStatusEnum.ASSIGNED]:             NextAction.START_ROUTE,
    [DispatchStatusEnum.OUT_FOR_DELIVERY]:     NextAction.FOLLOW_DELIVERY,
    [DispatchStatusEnum.IN_TRANSIT]:           NextAction.FOLLOW_DELIVERY,
    [DispatchStatusEnum.PICKUP_SCHEDULED]:     NextAction.FOLLOW_DELIVERY,
    [DispatchStatusEnum.PICKED_UP_IN_TRANSIT]: NextAction.FOLLOW_DELIVERY,
    [DispatchStatusEnum.INCIDENT]:             NextAction.RESOLVE_INCIDENT,
};

export function nextActionOf(status: string): NextAction {
    const action = NEXT_ACTION_BY_STATUS[status];
    if (!action) throw new RangeError(`No next action for the status: ${status}`);
    return action;
}
