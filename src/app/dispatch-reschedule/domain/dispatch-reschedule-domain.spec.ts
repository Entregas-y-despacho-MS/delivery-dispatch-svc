import { describe, expect, it } from 'vitest';
import { buildTimeSlots } from '../../planning/domain/time-slots.js';
import { batchExitPolicy } from './batch-exit-policy.js';
import { isReschedulableStatus, isReturnableStatus } from './reschedulable-status.js';
import { checkRescheduleWindow } from './reschedule-window.js';

// Slots of the operation: 09-11, 11-13, 14-16, 16-18 (La Paz time, UTC-4).
const slots = buildTimeSlots({ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }, 120);
// Monday 2026-10-19, 11:00 in La Paz.
const now = new Date('2026-10-19T15:00:00Z');

describe('checkRescheduleWindow', () => {
    it('accepts a morning slot of a future day and derives the date and the shift', () => {
        expect(checkRescheduleWindow(new Date('2026-10-21T13:00:00Z'), new Date('2026-10-21T15:00:00Z'), now, slots))
            .toEqual({ ok: true, date: '2026-10-21', shift: 'morning' });
    });

    it('derives the afternoon shift from a slot that starts at 12:00 or later', () => {
        expect(checkRescheduleWindow(new Date('2026-10-21T18:00:00Z'), new Date('2026-10-21T20:00:00Z'), now, slots))
            .toEqual({ ok: true, date: '2026-10-21', shift: 'afternoon' });
    });

    it('accepts a slot of today, even one that already started: only the date is checked', () => {
        expect(checkRescheduleWindow(new Date('2026-10-19T13:00:00Z'), new Date('2026-10-19T15:00:00Z'), now, slots).ok).toBe(true);
    });

    it('rejects a date before today in La Paz time, not in UTC', () => {
        expect(checkRescheduleWindow(new Date('2026-10-18T18:00:00Z'), new Date('2026-10-18T20:00:00Z'), now, slots))
            .toEqual({ ok: false, problem: 'past-date' });
        // 2026-10-19T02:00Z is still the 18th in La Paz (22:00).
        expect(checkRescheduleWindow(new Date('2026-10-19T02:00:00Z'), new Date('2026-10-19T04:00:00Z'), now, slots))
            .toEqual({ ok: false, problem: 'past-date' });
    });

    it('rejects an end that is not after the start', () => {
        expect(checkRescheduleWindow(new Date('2026-10-21T15:00:00Z'), new Date('2026-10-21T13:00:00Z'), now, slots))
            .toEqual({ ok: false, problem: 'end-not-after-start' });
    });

    it('rejects a window that ends on another local day', () => {
        expect(checkRescheduleWindow(new Date('2026-10-21T13:00:00Z'), new Date('2026-10-22T15:00:00Z'), now, slots))
            .toEqual({ ok: false, problem: 'not-same-day' });
    });

    it.each([
        ['a window that is not one of the slots', '2026-10-21T13:30:00Z', '2026-10-21T15:30:00Z'],
        ['a window inside the lunch break', '2026-10-21T17:00:00Z', '2026-10-21T18:00:00Z'],
        ['a window longer than a slot', '2026-10-21T13:00:00Z', '2026-10-21T17:00:00Z'],
        ['an instant with seconds', '2026-10-21T13:00:30Z', '2026-10-21T15:00:00Z'],
    ])('rejects %s', (_name, start, end) => {
        expect(checkRescheduleWindow(new Date(start), new Date(end), now, slots)).toEqual({ ok: false, problem: 'not-a-slot' });
    });

    it('rejects everything when there are no slots (windows not configured)', () => {
        expect(checkRescheduleWindow(new Date('2026-10-21T13:00:00Z'), new Date('2026-10-21T15:00:00Z'), now, []))
            .toEqual({ ok: false, problem: 'not-a-slot' });
    });
});

describe('reschedulable and returnable states', () => {
    it.each(['incident', 'not_delivered', 'scheduled', 'assigned'])('%s can be rescheduled', (status) => {
        expect(isReschedulableStatus(status)).toBe(true);
    });

    it.each(['pending', 'in_planning', 'out_for_delivery', 'in_transit', 'delivered', 'rescheduled', 'returned', 'cancelled'])('%s cannot be rescheduled', (status) => {
        expect(isReschedulableStatus(status)).toBe(false);
    });

    it('only a failed delivery can be returned to the warehouse', () => {
        expect(['incident', 'not_delivered'].every(isReturnableStatus)).toBe(true);
        expect(['scheduled', 'assigned', 'rescheduled', 'returned', 'delivered'].some(isReturnableStatus)).toBe(false);
    });
});

describe('batchExitPolicy', () => {
    it('closes the gap and cancels an emptied batch while it is provisional', () => {
        expect(batchExitPolicy('provisional')).toEqual({ touchBatch: true, closeSequenceGap: true, cancelWhenEmpty: true, evaluateClosing: false });
    });

    it.each(['pending_final_review', 'confirmed'])('freezes the sequence of a %s batch but cancels it when emptied', (status) => {
        expect(batchExitPolicy(status)).toEqual({ touchBatch: true, closeSequenceGap: false, cancelWhenEmpty: true, evaluateClosing: false });
    });

    it('evaluates the automatic closing of an in_execution batch and never cancels it', () => {
        expect(batchExitPolicy('in_execution')).toEqual({ touchBatch: true, closeSequenceGap: false, cancelWhenEmpty: false, evaluateClosing: true });
    });

    it.each(['closed', 'cancelled', 'unknown'])('does not touch a %s batch', (status) => {
        expect(batchExitPolicy(status)).toEqual({ touchBatch: false, closeSequenceGap: false, cancelWhenEmpty: false, evaluateClosing: false });
    });
});
