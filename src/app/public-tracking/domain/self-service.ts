/**
 * What the customer can still do from the tracking link (ST-224.1, D-47, D-29). Pure.
 *
 * The self-service ends with the first of: the original response window elapses (counted from the first valid
 * notice, `promise_notified_at`, never renewed), the customer confirms, or `max_reschedule_attempts`
 * rescheduling is reached. After that only «request change» remains, and the coordinator decides.
 */
import { DispatchStatusEnum } from '../../../shared/enums/index.js';

export type SelfServiceClosedReason =
    | 'not_open'
    | 'change_requested'
    | 'no_valid_notice'
    | 'window_elapsed'
    | 'confirmed'
    | 'max_attempts';

export interface SelfServiceInput {
    status: string;
    customerConfirmation: string;
    promiseNotifiedAt: Date | null;
    /** The dispatch has an email to send the verification code to. */
    hasContactEmail: boolean;
    /** Reschedulings already made by the customer (`dispatch_reschedules`, `customer`). */
    rescheduleAttemptsUsed: number;
    maxRescheduleAttempts: number;
    windowMinutes: number;
    /** `warehouse_prep_lead_minutes` and `reschedule_code_expiry_minutes` have a value. */
    rescheduleConfigured: boolean;
    now: Date;
}

export interface SelfServiceState {
    open: boolean;
    closedReason: SelfServiceClosedReason | null;
    /** End of the original response window; `null` while there is no valid notice. */
    windowClosesAt: Date | null;
    rescheduleAttemptsLeft: number;
    canConfirm: boolean;
    canReschedule: boolean;
    canRequestChange: boolean;
}

/** States in which the coordinator can still evaluate a change asked by the customer. */
const CHANGE_REQUEST_STATUSES: string[] = [DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED];

export function evaluateSelfService(input: SelfServiceInput): SelfServiceState {
    const windowClosesAt = input.promiseNotifiedAt
        ? new Date(input.promiseNotifiedAt.getTime() + input.windowMinutes * 60_000)
        : null;
    const attemptsLeft = Math.max(0, input.maxRescheduleAttempts - input.rescheduleAttemptsUsed);

    const closedReason = closedReasonOf(input, windowClosesAt, attemptsLeft);
    const open = closedReason === null;
    return {
        open,
        closedReason,
        windowClosesAt,
        rescheduleAttemptsLeft: attemptsLeft,
        canConfirm: open && input.customerConfirmation === 'pending',
        canReschedule: open && input.hasContactEmail && input.rescheduleConfigured,
        canRequestChange: CHANGE_REQUEST_STATUSES.includes(input.status) && input.customerConfirmation !== 'change_requested',
    };
}

function closedReasonOf(
    input: SelfServiceInput,
    windowClosesAt: Date | null,
    attemptsLeft: number,
): SelfServiceClosedReason | null {
    if (input.status !== DispatchStatusEnum.SCHEDULED) return 'not_open';
    if (input.customerConfirmation === 'change_requested') return 'change_requested';
    // A bounced notice never started the clock: there is no promise the customer could answer.
    if (windowClosesAt === null) return 'no_valid_notice';
    if (input.now.getTime() >= windowClosesAt.getTime()) return 'window_elapsed';
    if (input.customerConfirmation === 'confirmed') return 'confirmed';
    if (attemptsLeft === 0) return 'max_attempts';
    return null;
}
