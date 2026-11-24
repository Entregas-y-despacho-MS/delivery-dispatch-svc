/**
 * Classification of a supplier-pickup appointment (ST-305.1, ES-305 section 5A). One dispatch falls in exactly one category.
 * The repository returns the raw facts of each dispatch and this is the only place that decides what they mean, so the counts
 * and the list of exceptions can never disagree.
 */
export enum AppointmentCategory {
    /** Appointment expired and the carrier took custody on or before the end of the window in force. */
    ON_TIME = 'onTime',
    /** Appointment expired and the carrier took custody after the end of the window in force. */
    LATE = 'late',
    /** Appointment expired, no custody, and the pickup failed (`incident`, `not_delivered`). */
    FAILED = 'failed',
    /** Appointment expired, no custody and still active: an actionable exception with no result yet. */
    OPEN_OVERDUE = 'openOverdue',
    /** Window still ahead of the cut (even if already collected early): not part of the rate. */
    PENDING_NOT_DUE = 'pendingNotDue',
    CANCELLED = 'cancelled',
    /** Window missing or ending before it starts. */
    NO_VALID_APPOINTMENT = 'noValidAppointment',
    /** Appointment expired and the dispatch says it was collected, but `custody_received_at` is missing: N/D, never guessed. */
    UNKNOWN_TIMING = 'unknownTiming',
}

/** The categories that make up the denominator of the rate: expired appointments with a valid result. */
export const RESULT_CATEGORIES: readonly AppointmentCategory[] = [AppointmentCategory.ON_TIME, AppointmentCategory.LATE, AppointmentCategory.FAILED];

/** The categories shown as actionable exceptions. */
export const EXCEPTION_CATEGORIES: readonly AppointmentCategory[] = [
    AppointmentCategory.FAILED,
    AppointmentCategory.OPEN_OVERDUE,
    AppointmentCategory.LATE,
    AppointmentCategory.UNKNOWN_TIMING,
];

const FAILED_STATUSES: readonly string[] = ['incident', 'not_delivered'];
/** Statuses that say the cargo was collected; with no `custody_received_at` the moment is unknown. */
const COLLECTED_STATUSES: readonly string[] = ['picked_up_in_transit', 'delivered', 'returned_to_warehouse'];

export interface AppointmentFacts {
    status: string;
    /** Window in force (last accepted). */
    windowStart: Date | null;
    windowEnd: Date | null;
    /** Moment the carrier confirmed the collection. Not the arrival at the warehouse and not the inventory receipt. */
    custodyReceivedAt: Date | null;
}

export function hasValidWindow(facts: Pick<AppointmentFacts, 'windowStart' | 'windowEnd'>): boolean {
    return facts.windowStart !== null && facts.windowEnd !== null && facts.windowEnd.getTime() >= facts.windowStart.getTime();
}

/** `now` is the cut: an appointment is expired when the end of its window is strictly before it. */
export function classifyAppointment(facts: AppointmentFacts, now: Date): AppointmentCategory {
    if (facts.status === 'cancelled') return AppointmentCategory.CANCELLED;
    if (!hasValidWindow(facts)) return AppointmentCategory.NO_VALID_APPOINTMENT;
    const windowEnd = facts.windowEnd as Date;
    if (windowEnd.getTime() >= now.getTime()) return AppointmentCategory.PENDING_NOT_DUE;

    if (facts.custodyReceivedAt !== null) {
        return facts.custodyReceivedAt.getTime() <= windowEnd.getTime() ? AppointmentCategory.ON_TIME : AppointmentCategory.LATE;
    }
    if (COLLECTED_STATUSES.includes(facts.status)) return AppointmentCategory.UNKNOWN_TIMING;
    if (FAILED_STATUSES.includes(facts.status)) return AppointmentCategory.FAILED;
    return AppointmentCategory.OPEN_OVERDUE;
}
