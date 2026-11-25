import { percentage } from '../../delivery-promise/domain/percentage.js';
import { AppointmentCategory, RESULT_CATEGORIES } from './appointment-classifier.js';

export type CategoryCounts = Record<AppointmentCategory, number>;

/** Why the rate has no value: «Sin datos» always comes with its cause. */
export type ComplianceUnavailableReason = 'missing_timestamp' | 'no_valid_results';

export interface ComplianceMetrics {
    numerator: number;
    denominator: number;
    n: number;
    /** `null` is N/D, never 0. */
    percentage: number | null;
    unavailableReason: ComplianceUnavailableReason | null;
}

export interface RescheduleFacts {
    /** Moment of the first reschedule of the dispatch; `null` when it was never rescheduled. */
    firstRescheduleAt: Date | null;
    /** End of the window that the first reschedule replaced, i.e. the original appointment. */
    originalWindowEnd: Date | null;
}

export function emptyCounts(): CategoryCounts {
    return Object.fromEntries(Object.values(AppointmentCategory).map((category) => [category, 0])) as CategoryCounts;
}

/** Compliance = collected inside the appointment / expired appointments with a valid result (on time, late, failed). */
export function buildComplianceMetrics(counts: CategoryCounts): ComplianceMetrics {
    const denominator = RESULT_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
    const unavailableReason: ComplianceUnavailableReason | null = denominator > 0 ? null
        : counts[AppointmentCategory.UNKNOWN_TIMING] > 0 ? 'missing_timestamp' : 'no_valid_results';
    return {
        numerator: counts[AppointmentCategory.ON_TIME],
        denominator,
        n: denominator,
        percentage: percentage(counts[AppointmentCategory.ON_TIME], denominator),
        unavailableReason,
    };
}

/** True when the appointment was rescheduled after its original window had already expired (shown apart, kept for audit). */
export function originalExpiredBeforeReschedule(facts: RescheduleFacts): boolean {
    return facts.firstRescheduleAt !== null && facts.originalWindowEnd !== null
        && facts.originalWindowEnd.getTime() < facts.firstRescheduleAt.getTime();
}
