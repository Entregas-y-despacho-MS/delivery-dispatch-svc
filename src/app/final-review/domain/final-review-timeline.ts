/**
 * Timeline of the 2nd approval that is out of time (ST-51.4, D-46). Pure functions: no Nest, no
 * database, no clock — the caller passes the instant it wants evaluated.
 *
 * Milestones of a route day D (docs/decisiones-planificacion-semiautomatica.md §4.1):
 *   D-1 `final_review_end_time`   alert if the batch is still `pending_final_review`.
 *   D-1 `route_reminder_time`     reminder, only for `confirmed` batches.
 *   D   `final_review_escalation_time`  still not approved → case 5.2 and a risk notice.
 * There is no automatic approval at any point.
 */
import { validateSettingValue } from '../../../modules/settings/utils/setting-value.validator.js';
import {
    isOperatingDay,
    localDate,
    localInstant,
    nextOperatingDay,
    previousOperatingDay,
    type OperatingCalendar,
} from '../../planning/domain/operating-calendar.js';

export type FinalReviewMilestone = 'review-end' | 'reminder' | 'escalation';

export const FINAL_REVIEW_SETTING_KEYS = [
    'plan_working_days',
    'plan_non_working_dates',
    'final_review_end_time',
    'route_reminder_time',
    'final_review_escalation_time',
] as const;

/** Keys that must be present; `plan_non_working_dates` may be empty (no holidays). */
const REQUIRED_KEYS = FINAL_REVIEW_SETTING_KEYS.filter((key) => key !== 'plan_non_working_dates');

export interface FinalReviewSettings {
    calendar: OperatingCalendar;
    /** `final_review_end_time`, `HH:mm`. */
    finalReviewEndTime: string;
    /** `route_reminder_time`, `HH:mm`. */
    routeReminderTime: string;
    /** `final_review_escalation_time`, `HH:mm`. */
    finalReviewEscalationTime: string;
}

export interface FinalReviewSettingsResult {
    ok: boolean;
    values: FinalReviewSettings | null;
    missingKeys: string[];
    invalidKeys: string[];
}

export type RawFinalReviewSettings = Record<string, string | null | undefined>;

function isBlank(value: string | null | undefined): boolean {
    return value === null || value === undefined || value.trim() === '';
}

function split(value: string): string[] {
    return value.split(',').map((item) => item.trim());
}

export function parseFinalReviewSettings(raw: RawFinalReviewSettings): FinalReviewSettingsResult {
    const missingKeys: string[] = [];
    const invalidKeys: string[] = [];
    for (const key of REQUIRED_KEYS) {
        const value = raw[key];
        if (isBlank(value)) missingKeys.push(key);
        else if (validateSettingValue(key, value!.trim()) !== null) invalidKeys.push(key);
    }
    const holidays = raw.plan_non_working_dates;
    if (!isBlank(holidays) && validateSettingValue('plan_non_working_dates', holidays!.trim()) !== null) {
        invalidKeys.push('plan_non_working_dates');
    }
    if (missingKeys.length > 0 || invalidKeys.length > 0) {
        return { ok: false, values: null, missingKeys, invalidKeys };
    }

    const get = (key: string): string => raw[key]!.trim();
    return {
        ok: true,
        values: {
            calendar: {
                workingWeekdays: new Set(split(get('plan_working_days')).map(Number)),
                nonWorkingDates: new Set(isBlank(holidays) ? [] : split(holidays!.trim())),
            },
            finalReviewEndTime: get('final_review_end_time'),
            routeReminderTime: get('route_reminder_time'),
            finalReviewEscalationTime: get('final_review_escalation_time'),
        },
        missingKeys,
        invalidKeys,
    };
}

/** Anything that can answer a setting by key (SettingsService); `''` is returned when it is absent. */
export interface FinalReviewSettingsReader {
    getString(key: string, fallback: string): Promise<string>;
}

export async function loadFinalReviewSettings(reader: FinalReviewSettingsReader): Promise<FinalReviewSettingsResult> {
    const raw: RawFinalReviewSettings = {};
    for (const key of FINAL_REVIEW_SETTING_KEYS) raw[key] = await reader.getString(key, '');
    return parseFinalReviewSettings(raw);
}

/**
 * Route day a scheduled milestone works on at `now`, or `null` when today is not its day.
 * - `review-end` and `reminder` belong to D-1: today must be the operating day before the next route
 *   day (same rule as the cutoff, so a Saturday never touches Monday's batch).
 * - `escalation` belongs to D itself: the route day is today, when it operates.
 */
export function shiftDateOfMilestone(
    milestone: FinalReviewMilestone,
    now: Date,
    calendar: OperatingCalendar,
): string | null {
    const today = localDate(now);
    if (milestone === 'escalation') return isOperatingDay(today, calendar) ? today : null;
    const shiftDate = nextOperatingDay(today, calendar);
    return previousOperatingDay(shiftDate, calendar) === today ? shiftDate : null;
}

/** Batch statuses each milestone looks at. Remnants of the cutoff (`provisional`) join the escalation only. */
export const MILESTONE_BATCH_STATUSES: Readonly<Record<FinalReviewMilestone, readonly string[]>> = {
    'review-end': ['pending_final_review'],
    reminder: ['confirmed'],
    escalation: ['pending_final_review', 'provisional'],
};

/** Instant of `route_reminder_time` on D-1 of a route day. */
export function reminderInstant(shiftDate: string, settings: FinalReviewSettings): Date {
    return localInstant(previousOperatingDay(shiftDate, settings.calendar), settings.routeReminderTime);
}

/** Instant of `final_review_escalation_time` on the route day itself. */
export function escalationInstant(shiftDate: string, settings: FinalReviewSettings): Date {
    return localInstant(shiftDate, settings.finalReviewEscalationTime);
}

/**
 * Where one customer email stands for one order and batch:
 * - `none`: never reserved;
 * - `in_flight`: reserved, no result yet, and the lease has not run out (it may still be delivered);
 * - `sent`: the transport accepted it;
 * - `failed`: it bounced, failed or was abandoned (the reservation outlived its lease). Never retried.
 */
export type NoticeStatus = 'none' | 'in_flight' | 'sent' | 'failed';

export interface CustomerNoticeState {
    /** The normal reminder. */
    reminder: NoticeStatus;
    /** The risk notice of the escalation (case 5.2). */
    risk: NoticeStatus;
    /** «Tu entrega se mantiene». */
    maintained: NoticeStatus;
}

export type CustomerNoticeAction = 'send-reminder' | 'send-delivery-maintained' | 'wait' | 'defer' | 'none';

/**
 * What a customer of a `confirmed` batch is owed at `now`. One rule serves the 16:30 task, the late
 * approval and the reconciliation task, so each email is reserved exactly once:
 * - «tu entrega se mantiene» is only owed to a customer who really got the risk notice (`sent`);
 * - a risk notice still in flight is not decided yet (`defer`): if it bounces the customer is owed the normal
 *   reminder instead, and saying «se mantiene» now would be wrong; whoever records the result decides again;
 * - otherwise, from `route_reminder_time` on → the normal reminder (also when the batch is approved after
 *   16:30, and also when the risk notice failed or was abandoned);
 * - before that hour → `wait`: the 16:30 task will send it.
 * An email already reserved, in any state, is never reserved again.
 */
export function customerNoticeAction(
    now: Date,
    shiftDate: string,
    settings: FinalReviewSettings,
    state: CustomerNoticeState,
): CustomerNoticeAction {
    if (state.maintained !== 'none') return 'none';
    if (state.risk === 'in_flight') return 'defer';
    if (state.risk === 'sent') return 'send-delivery-maintained';
    if (state.reminder !== 'none') return 'none';
    return now.getTime() >= reminderInstant(shiftDate, settings).getTime() ? 'send-reminder' : 'wait';
}
