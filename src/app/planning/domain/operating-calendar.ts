/**
 * Operating calendar and the "first viable date" rule of the plan generator (ST-50.2, D-01, D-49).
 * Pure functions: no Nest, no database, no clock. Every date is a local America/La_Paz calendar date
 * written `YYYY-MM-DD`; the caller passes the instant it wants evaluated.
 *
 * Vocabulary (docs/decisiones-planificacion-semiautomatica.md §2): D0 is the local date the order was
 * confirmed; Dk is the k-th operating day strictly after D0. The company only promises D2 or D3, never
 * D0, D1 or D4. D2 is offered only when the customer window of 12 h can expire before the cutoff of D-1.
 */
import { toLocalMoment } from '../../scheduler/domain/task-schedule.js';

/** Bolivia has no daylight saving time: America/La_Paz is UTC-4 all year. */
const LA_PAZ_UTC_OFFSET_HOURS = -4;

export interface OperatingCalendar {
    /** ISO weekdays that operate: 1 = Monday … 7 = Sunday (`plan_working_days`). */
    workingWeekdays: ReadonlySet<number>;
    /** Holidays, `YYYY-MM-DD` (`plan_non_working_dates`). */
    nonWorkingDates: ReadonlySet<string>;
}

export interface PromiseDateRules {
    /** `service_min_operating_days` — 2 means D2. */
    minOperatingDays: number;
    /** `service_max_operating_days` — 3 means D3. */
    maxOperatingDays: number;
    /** `route_cutoff_time`, `HH:mm`. */
    routeCutoffTime: string;
    /** `promise_response_window_minutes` — the customer window, 12 h. */
    promiseResponseWindowMinutes: number;
}

export interface CandidateDate {
    /** k of Dk. */
    operatingDay: number;
    /** Local date `YYYY-MM-DD`. */
    date: string;
    /** Local date of D-1, the operating day before `date`. */
    cutoffDate: string;
    /** Instant of the cutoff of D-1. */
    cutoffAt: Date;
    /** Whether `now` plus the customer window ends before `cutoffAt`. */
    viable: boolean;
}

export interface DayCutoff {
    /** Local date of the day before (the previous operating day). */
    cutoffDate: string;
    cutoffAt: Date;
}

function toUtcDate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(date: string, days: number): string {
    const moved = toUtcDate(date);
    moved.setUTCDate(moved.getUTCDate() + days);
    return moved.toISOString().slice(0, 10);
}

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
    const day = toUtcDate(date).getUTCDay();
    return day === 0 ? 7 : day;
}

export function isOperatingDay(date: string, calendar: OperatingCalendar): boolean {
    return calendar.workingWeekdays.has(isoWeekday(date)) && !calendar.nonWorkingDates.has(date);
}

function assertCalendarHasOperatingDays(calendar: OperatingCalendar): void {
    const weekdays = [...calendar.workingWeekdays].filter((weekday) => weekday >= 1 && weekday <= 7);
    if (weekdays.length === 0) throw new Error('The operating calendar has no working weekday.');
}

/** The first operating day strictly after `date` (`date` itself may not be one). */
export function nextOperatingDay(date: string, calendar: OperatingCalendar): string {
    assertCalendarHasOperatingDays(calendar);
    let cursor = addDays(date, 1);
    while (!isOperatingDay(cursor, calendar)) cursor = addDays(cursor, 1);
    return cursor;
}

/** The last operating day strictly before `date`. */
export function previousOperatingDay(date: string, calendar: OperatingCalendar): string {
    assertCalendarHasOperatingDays(calendar);
    let cursor = addDays(date, -1);
    while (!isOperatingDay(cursor, calendar)) cursor = addDays(cursor, -1);
    return cursor;
}

/** Dk: the k-th operating day strictly after D0 (k ≥ 1). */
export function operatingDayAfter(d0: string, k: number, calendar: OperatingCalendar): string {
    let cursor = d0;
    for (let step = 0; step < k; step++) cursor = nextOperatingDay(cursor, calendar);
    return cursor;
}

/** The instant of a local La Paz date and `HH:mm`. */
export function localInstant(date: string, time: string): Date {
    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours - LA_PAZ_UTC_OFFSET_HOURS, minutes));
}

/** The local date D0 of an order confirmed at `instant`. */
export function localDate(instant: Date): string {
    return toLocalMoment(instant).date;
}

/** Cutoff that applies to `date`: the previous operating day at `route_cutoff_time`. */
export function cutoffBefore(date: string, routeCutoffTime: string, calendar: OperatingCalendar): DayCutoff {
    const cutoffDate = previousOperatingDay(date, calendar);
    return { cutoffDate, cutoffAt: localInstant(cutoffDate, routeCutoffTime) };
}

/**
 * Every candidate day D_min … D_max of an order, with whether each one is still viable at `now`.
 * D0 and D1 are never candidates because `minOperatingDays` is 2, and the list stops at D_max, so
 * D4 is never offered.
 */
export function evaluateCandidateDates(
    orderConfirmedAt: Date,
    now: Date,
    calendar: OperatingCalendar,
    rules: PromiseDateRules,
): CandidateDate[] {
    const d0 = localDate(orderConfirmedAt);
    const customerWindowEnd = now.getTime() + rules.promiseResponseWindowMinutes * 60_000;

    const candidates: CandidateDate[] = [];
    for (let k = rules.minOperatingDays; k <= rules.maxOperatingDays; k++) {
        const date = operatingDayAfter(d0, k, calendar);
        const { cutoffDate, cutoffAt } = cutoffBefore(date, rules.routeCutoffTime, calendar);
        candidates.push({
            operatingDay: k,
            date,
            cutoffDate,
            cutoffAt,
            viable: customerWindowEnd <= cutoffAt.getTime(),
        });
    }
    return candidates;
}

/** The viable candidates, earliest first. A generator tries them in order (D2, then D3). */
export function viableCandidateDates(
    orderConfirmedAt: Date,
    now: Date,
    calendar: OperatingCalendar,
    rules: PromiseDateRules,
): CandidateDate[] {
    return evaluateCandidateDates(orderConfirmedAt, now, calendar, rules).filter((candidate) => candidate.viable);
}

/** First viable date between D_min and D_max, or `null` when none fits (an exception, never D4). */
export function firstViableDate(
    orderConfirmedAt: Date,
    now: Date,
    calendar: OperatingCalendar,
    rules: PromiseDateRules,
): CandidateDate | null {
    return viableCandidateDates(orderConfirmedAt, now, calendar, rules)[0] ?? null;
}

/**
 * Fixed date of a `rescheduled` dispatch (D-49): the last agreed window of its reschedule or, when
 * there is none, the one it already had. D2–D3 is not recomputed.
 */
export function fixedDateOfRescheduled(
    lastRescheduleWindowStart: Date | null | undefined,
    scheduledWindowStart: Date | null | undefined,
): string | null {
    const agreed = lastRescheduleWindowStart ?? scheduledWindowStart;
    return agreed ? localDate(agreed) : null;
}

export type RescheduledDateProblem = 'not-operating-day' | 'cutoff-passed';

/** Why the agreed date of a `rescheduled` dispatch cannot be planned at `now`, or `null` when it can. */
export function rescheduledDateProblem(
    date: string,
    now: Date,
    calendar: OperatingCalendar,
    routeCutoffTime: string,
): RescheduledDateProblem | null {
    if (!isOperatingDay(date, calendar)) return 'not-operating-day';
    const { cutoffAt } = cutoffBefore(date, routeCutoffTime, calendar);
    return now.getTime() >= cutoffAt.getTime() ? 'cutoff-passed' : null;
}

/** Minutes since local midnight of `HH:mm`. */
export function minutesOfDay(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}

/** The Monday of the ISO week of a local date, used to count a driver's batches per week. */
export function weekStart(date: string): string {
    return addDays(date, -(isoWeekday(date) - 1));
}
