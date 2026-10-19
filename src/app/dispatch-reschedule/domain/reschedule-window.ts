import { toLocalMoment } from '../../scheduler/domain/task-schedule.js';
import type { TimeSlot } from '../../planning/domain/time-slots.js';

export type RescheduleWindowProblem = 'past-date' | 'end-not-after-start' | 'not-same-day' | 'not-a-slot';
export type RescheduleShift = 'morning' | 'afternoon';

export type RescheduleWindowCheck =
    | { ok: true; date: string; shift: RescheduleShift }
    | { ok: false; problem: RescheduleWindowProblem };

/** A slot starting before 12:00 local time is the morning shift, as the inbox derives it. */
const NOON_MINUTE = 12 * 60;

/**
 * Checks the window agreed for a rescheduled delivery (ES-52, decision D3 of the plan of ST-52.2):
 * the local (America/La_Paz) date of `windowStart` is not before today, the window ends after it on the same
 * local day, and it is exactly one of the delivery slots (`morning_window_*` / `afternoon_window_*` cut every
 * `slot_duration_minutes`). That date is the one the planner fixes for the dispatch (D-49).
 */
export function checkRescheduleWindow(windowStart: Date, windowEnd: Date, now: Date, slots: readonly TimeSlot[]): RescheduleWindowCheck {
    const start = toLocalMoment(windowStart);
    if (start.date < toLocalMoment(now).date) return { ok: false, problem: 'past-date' };
    if (windowEnd.getTime() <= windowStart.getTime()) return { ok: false, problem: 'end-not-after-start' };

    const end = toLocalMoment(windowEnd);
    if (end.date !== start.date) return { ok: false, problem: 'not-same-day' };

    const wholeMinutes = windowStart.getTime() % 60_000 === 0 && windowEnd.getTime() % 60_000 === 0;
    const isSlot = wholeMinutes && slots.some((slot) => slot.startMinute === start.minuteOfDay && slot.endMinute === end.minuteOfDay);
    if (!isSlot) return { ok: false, problem: 'not-a-slot' };

    return { ok: true, date: start.date, shift: start.minuteOfDay < NOON_MINUTE ? 'morning' : 'afternoon' };
}
