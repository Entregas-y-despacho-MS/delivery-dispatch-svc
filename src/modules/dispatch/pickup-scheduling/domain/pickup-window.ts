/**
 * Window rules of a supplier pickup (ST-75.1, ERP-04). Pure functions: no Nest, no database, no clock.
 *
 * The supplier gives one date-time range (`pickupWindow` of `procurement.pickup.requested`); the
 * destination warehouse receives goods every day between two local times. The attention window is
 * the part of the supplier range that falls inside the warehouse's daily reception hours, in the
 * operating time zone (America/La_Paz).
 */
import { addDays, localDate, localInstant } from '../../../../app/planning/domain/operating-calendar.js';

export interface TimeRange {
    startsAt: Date;
    endsAt: Date;
}

/** Daily reception hours of the warehouse, local `HH:mm` or `HH:mm:ss` (Postgres TIME). */
export interface DailyReception {
    start: string;
    end: string;
}

/** `HH:mm:ss` → `HH:mm`; the instants are built to the minute. */
function toMinutePrecision(time: string): string {
    return time.slice(0, 5);
}

/**
 * Every slot where the supplier range and the warehouse's daily reception hours overlap, oldest first.
 * Empty when they never overlap (or the reception hours are not a positive range).
 */
export function intersectPickupWindows(supplier: TimeRange, reception: DailyReception): TimeRange[] {
    if (supplier.endsAt.getTime() <= supplier.startsAt.getTime()) return [];
    const receptionStart = toMinutePrecision(reception.start);
    const receptionEnd = toMinutePrecision(reception.end);
    if (receptionEnd <= receptionStart) return [];

    const lastDay = localDate(supplier.endsAt);
    const slots: TimeRange[] = [];
    for (let day = localDate(supplier.startsAt); day <= lastDay; day = addDays(day, 1)) {
        const startsAt = new Date(
            Math.max(localInstant(day, receptionStart).getTime(), supplier.startsAt.getTime()),
        );
        const endsAt = new Date(
            Math.min(localInstant(day, receptionEnd).getTime(), supplier.endsAt.getTime()),
        );
        if (endsAt.getTime() > startsAt.getTime()) slots.push({ startsAt, endsAt });
    }
    return slots;
}

/** Whether `range` fits entirely inside one of `slots`. */
export function isWithinAnySlot(range: TimeRange, slots: readonly TimeRange[]): boolean {
    if (range.endsAt.getTime() <= range.startsAt.getTime()) return false;
    return slots.some(
        (slot) =>
            range.startsAt.getTime() >= slot.startsAt.getTime() &&
            range.endsAt.getTime() <= slot.endsAt.getTime(),
    );
}

/**
 * Whether a new pickup start respects `reschedule_window_days` (ES-57): strictly after the current
 * start and at most `maxDays` local calendar days later.
 */
export function isWithinRescheduleLimit(currentStart: Date, newStart: Date, maxDays: number): boolean {
    if (newStart.getTime() <= currentStart.getTime()) return false;
    return localDate(newStart) <= addDays(localDate(currentStart), maxDays);
}
