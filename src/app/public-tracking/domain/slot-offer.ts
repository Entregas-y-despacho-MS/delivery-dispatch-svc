/**
 * Which slots the customer may be offered when rescheduling (ST-224.1, D-47). Pure.
 *
 * Only batches that are still OPEN (provisional) in the customer's own zone and warehouse, whose cutoff of D-1
 * has not passed and that leave the warehouse the lead time it needs, on a date inside the range the company
 * allows. Whether the route stays feasible (windows of notified stops, vehicle, capacity) is decided by the same
 * simulation the plan generator uses for a late order; this module only filters and presents.
 */
import {
    addDays, cutoffBefore, localDate, localInstant, operatingDayAfter, type OperatingCalendar,
} from '../../planning/domain/operating-calendar.js';
import type { OpenBatch } from '../../planning/domain/plan-types.js';
import type { SimStopResult } from '../../planning/domain/route-simulation.js';

export interface OfferRules {
    now: Date;
    calendar: OperatingCalendar;
    /** `route_cutoff_time`, `HH:mm`. */
    routeCutoffTime: string;
    /** `service_min_operating_days`: an order is never promised sooner than D2. */
    minOperatingDays: number;
    orderConfirmedAt: Date;
    /** Local date of the batch the dispatch is in now. */
    currentShiftDate: string;
    /** `reschedule_window_days`: how far past the current date a slot may be. */
    rescheduleWindowDays: number;
    /** `warehouse_prep_lead_minutes`. */
    prepLeadMinutes: number;
    /** `warehouse_prep_end_time`, `HH:mm`: when the warehouse must be done on the day of the route. */
    prepEndTime: string;
}

export interface DateRange {
    minDate: string;
    maxDate: string;
}

/** From D2 of the order to `reschedule_window_days` after the date it has now. */
export function offerDateRange(rules: OfferRules): DateRange {
    return {
        minDate: operatingDayAfter(localDate(rules.orderConfirmedAt), rules.minOperatingDays, rules.calendar),
        maxDate: addDays(rules.currentShiftDate, rules.rescheduleWindowDays),
    };
}

/** The date, the cutoff and the warehouse's lead time of one open batch. Zone, vehicle and capacity are checked elsewhere. */
export function batchIsOfferable(batch: OpenBatch, rules: OfferRules, range: DateRange): boolean {
    if (batch.shiftDate < range.minDate || batch.shiftDate > range.maxDate) return false;

    const { cutoffAt } = cutoffBefore(batch.shiftDate, rules.routeCutoffTime, rules.calendar);
    if (rules.now.getTime() >= cutoffAt.getTime()) return false;

    // A promise the warehouse cannot prepare must not be firmed: the lead time has to fit before it finishes.
    const prepEndsAt = localInstant(batch.shiftDate, rules.prepEndTime);
    return rules.now.getTime() + rules.prepLeadMinutes * 60_000 <= prepEndsAt.getTime();
}

/** A way to put the customer's dispatch in an open batch, ready to be shown or, later, applied. */
export interface RescheduleOffer {
    routeBatchId: number;
    /** `route_batches.version` when it was read; the write checks it again under the lock. */
    batchVersion: number;
    deliveryDate: string;
    windowStart: Date;
    windowEnd: Date;
    /** Extra driving time the stop adds to the route. */
    costSeconds: number;
    /** 0-based place in the batch's sequence. */
    position: number;
    /** The whole simulated route with the stop in it: every stop's slot, in visiting order. */
    route: SimStopResult[];
}

/** Local instant of a minute-of-day on a date. */
export function minuteToInstant(date: string, minute: number): Date {
    const hours = String(Math.floor(minute / 60)).padStart(2, '0');
    const minutes = String(Math.round(minute % 60)).padStart(2, '0');
    return localInstant(date, `${hours}:${minutes}`);
}

/**
 * One offer per date and slot: when two batches of the zone can take the customer at the same time, the
 * one that adds the least driving time wins (ties: the lower batch id). Earliest first.
 */
export function chooseOffers(offers: RescheduleOffer[]): RescheduleOffer[] {
    const best = new Map<string, RescheduleOffer>();
    for (const offer of offers) {
        const key = `${offer.deliveryDate}|${offer.windowStart.getTime()}`;
        const kept = best.get(key);
        if (!kept || offer.costSeconds < kept.costSeconds
            || (offer.costSeconds === kept.costSeconds && offer.routeBatchId < kept.routeBatchId)) {
            best.set(key, offer);
        }
    }
    return [...best.values()].sort(
        (a, b) => a.windowStart.getTime() - b.windowStart.getTime() || a.routeBatchId - b.routeBatchId,
    );
}

/** What the customer sends back to choose: the batch and the start of the slot. Nothing secret, nothing to trust. */
export function buildSlotId(routeBatchId: number, windowStart: Date): string {
    return `${routeBatchId}.${Math.floor(windowStart.getTime() / 1000)}`;
}

const SLOT_ID_FORMAT = /^(\d{1,10})\.(\d{1,12})$/;

export function parseSlotId(slotId: string): { routeBatchId: number; windowStart: Date } | null {
    const match = SLOT_ID_FORMAT.exec(slotId);
    if (!match) return null;
    const routeBatchId = Number(match[1]);
    const seconds = Number(match[2]);
    if (!Number.isSafeInteger(routeBatchId) || routeBatchId < 1 || !Number.isSafeInteger(seconds)) return null;
    return { routeBatchId, windowStart: new Date(seconds * 1000) };
}
