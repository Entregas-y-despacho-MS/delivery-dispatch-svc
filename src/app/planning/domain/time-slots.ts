/**
 * Delivery slots of a route day (ST-50.2, plan §2.5). Pure: minutes since local midnight.
 *
 * The morning window and the afternoon window are cut every `slot_duration_minutes`. With the values
 * of the operation (09:00-13:00, 14:00-18:00, 120) that gives 09-11, 11-13, 14-16 and 16-18. A rest
 * smaller than a whole slot is dropped, and the break between the windows is not a slot.
 */
import { minutesOfDay } from './operating-calendar.js';
import type { TimeWindow } from './planning-settings.js';

export interface TimeSlot {
    startMinute: number;
    endMinute: number;
}

function cut(window: TimeWindow, slotMinutes: number): TimeSlot[] {
    const slots: TimeSlot[] = [];
    const end = minutesOfDay(window.end);
    for (let start = minutesOfDay(window.start); start + slotMinutes <= end; start += slotMinutes) {
        slots.push({ startMinute: start, endMinute: start + slotMinutes });
    }
    return slots;
}

export function buildTimeSlots(morning: TimeWindow, afternoon: TimeWindow, slotMinutes: number): TimeSlot[] {
    if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) return [];
    return [...cut(morning, slotMinutes), ...cut(afternoon, slotMinutes)].sort((a, b) => a.startMinute - b.startMinute);
}

/**
 * The slot a stop reached at `arrivalMinute` gets: the first one whose end is not before the arrival.
 * An arrival in the break takes the first slot of the afternoon (and waits for it); after the last
 * slot there is none.
 */
export function slotForArrival(slots: TimeSlot[], arrivalMinute: number): TimeSlot | null {
    return slots.find((slot) => slot.endMinute >= arrivalMinute) ?? null;
}
