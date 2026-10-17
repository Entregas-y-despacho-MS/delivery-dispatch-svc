import { describe, expect, it } from 'vitest';
import {
    customerNoticeAction,
    escalationInstant,
    MILESTONE_BATCH_STATUSES,
    parseFinalReviewSettings,
    reminderInstant,
    shiftDateOfMilestone,
    type CustomerNoticeState,
    type FinalReviewSettings,
} from './final-review-timeline.js';

// La Paz is UTC-4 all year: 16:30 La Paz = 20:30Z.
const RAW = {
    plan_working_days: '1,2,3,4,5',
    plan_non_working_dates: '',
    final_review_end_time: '16:00',
    route_reminder_time: '16:30',
    final_review_escalation_time: '07:00',
};

const settings = parseFinalReviewSettings(RAW).values as FinalReviewSettings;
const none: CustomerNoticeState = { reminder: 'none', risk: 'none', maintained: 'none' };

describe('parseFinalReviewSettings', () => {
    it('reads the calendar and the three times', () => {
        expect(settings.finalReviewEndTime).toBe('16:00');
        expect(settings.routeReminderTime).toBe('16:30');
        expect(settings.finalReviewEscalationTime).toBe('07:00');
        expect([...settings.calendar.workingWeekdays]).toEqual([1, 2, 3, 4, 5]);
        expect(settings.calendar.nonWorkingDates.size).toBe(0);
    });

    it('accepts an empty holiday list but reports missing and invalid keys', () => {
        expect(parseFinalReviewSettings(RAW).ok).toBe(true);
        const result = parseFinalReviewSettings({ ...RAW, route_reminder_time: '', final_review_end_time: '25:99' });
        expect(result).toMatchObject({ ok: false, values: null, missingKeys: ['route_reminder_time'], invalidKeys: ['final_review_end_time'] });
    });
});

describe('shiftDateOfMilestone', () => {
    it('review-end and reminder work on the next route day only when today is its D-1', () => {
        // Tuesday 2026-10-13 16:00 La Paz → Wednesday's batch.
        expect(shiftDateOfMilestone('review-end', new Date('2026-10-13T20:00:00Z'), settings.calendar)).toBe('2026-10-14');
        expect(shiftDateOfMilestone('reminder', new Date('2026-10-13T20:30:00Z'), settings.calendar)).toBe('2026-10-14');
        // Friday's D-1 for Monday.
        expect(shiftDateOfMilestone('review-end', new Date('2026-10-16T20:00:00Z'), settings.calendar)).toBe('2026-10-19');
    });

    it('does nothing on a weekend or a holiday: they are nobody\'s D-1', () => {
        expect(shiftDateOfMilestone('review-end', new Date('2026-10-17T20:00:00Z'), settings.calendar)).toBeNull();
        const holiday = parseFinalReviewSettings({ ...RAW, plan_non_working_dates: '2026-10-14' }).values!;
        expect(shiftDateOfMilestone('reminder', new Date('2026-10-14T20:30:00Z'), holiday.calendar)).toBeNull();
    });

    it('escalation works on the route day itself, when it operates', () => {
        expect(shiftDateOfMilestone('escalation', new Date('2026-10-14T11:00:00Z'), settings.calendar)).toBe('2026-10-14');
        expect(shiftDateOfMilestone('escalation', new Date('2026-10-17T11:00:00Z'), settings.calendar)).toBeNull();
    });

    it('uses the La Paz date, not the UTC one', () => {
        // 2026-10-14 01:00Z is still Tuesday 21:00 in La Paz.
        expect(shiftDateOfMilestone('review-end', new Date('2026-10-14T01:00:00Z'), settings.calendar)).toBe('2026-10-14');
    });
});

describe('milestone instants', () => {
    it('the reminder is at route_reminder_time of D-1 (Friday for a Monday)', () => {
        expect(reminderInstant('2026-10-14', settings).toISOString()).toBe('2026-10-13T20:30:00.000Z');
        expect(reminderInstant('2026-10-19', settings).toISOString()).toBe('2026-10-16T20:30:00.000Z');
    });

    it('the escalation is at final_review_escalation_time of D itself', () => {
        expect(escalationInstant('2026-10-14', settings).toISOString()).toBe('2026-10-14T11:00:00.000Z');
    });
});

describe('MILESTONE_BATCH_STATUSES', () => {
    it('the reminder only looks at confirmed batches; remnants join only the escalation', () => {
        expect(MILESTONE_BATCH_STATUSES.reminder).toEqual(['confirmed']);
        expect(MILESTONE_BATCH_STATUSES['review-end']).toEqual(['pending_final_review']);
        expect(MILESTONE_BATCH_STATUSES.escalation).toContain('provisional');
    });
});

describe('customerNoticeAction', () => {
    const shift = '2026-10-14';
    const BEFORE = new Date('2026-10-13T20:29:00Z'); // Tue 16:29 La Paz
    const AT = new Date('2026-10-13T20:30:00Z'); // Tue 16:30
    const AFTER = new Date('2026-10-14T13:00:00Z'); // Wed 09:00
    const state = (overrides: Partial<CustomerNoticeState> = {}): CustomerNoticeState => ({ ...none, ...overrides });

    it('waits before route_reminder_time: the 16:30 task will send it', () => {
        expect(customerNoticeAction(BEFORE, shift, settings, none)).toBe('wait');
    });

    it('sends the reminder at 16:30 and also when the batch is approved later (before any risk notice)', () => {
        expect(customerNoticeAction(AT, shift, settings, none)).toBe('send-reminder');
        expect(customerNoticeAction(new Date('2026-10-14T09:00:00Z'), shift, settings, none)).toBe('send-reminder');
    });

    it('«tu entrega se mantiene» is only owed to a customer who really got the risk notice', () => {
        expect(customerNoticeAction(AFTER, shift, settings, state({ risk: 'sent' }))).toBe('send-delivery-maintained');
    });

    it.each(['failed'] as const)('a risk notice that %s (bounced, failed or abandoned) owes the reminder, never «se mantiene»', (risk) => {
        expect(customerNoticeAction(AFTER, shift, settings, state({ risk }))).toBe('send-reminder');
    });

    it('a risk notice still in flight is not decided around: it is deferred until its result is known', () => {
        expect(customerNoticeAction(AFTER, shift, settings, state({ risk: 'in_flight' }))).toBe('defer');
        expect(customerNoticeAction(BEFORE, shift, settings, state({ risk: 'in_flight' }))).toBe('defer');
    });

    it('a failed risk notice before the reminder hour waits for the 16:30 reminder', () => {
        expect(customerNoticeAction(BEFORE, shift, settings, state({ risk: 'failed' }))).toBe('wait');
    });

    it.each(['in_flight', 'sent', 'failed'] as const)('never reserves again a reminder that is %s', (reminder) => {
        expect(customerNoticeAction(AFTER, shift, settings, state({ reminder }))).toBe('none');
    });

    it.each(['in_flight', 'sent', 'failed'] as const)('never reserves again a «se mantiene» that is %s', (maintained) => {
        expect(customerNoticeAction(AFTER, shift, settings, state({ risk: 'sent', maintained }))).toBe('none');
    });
});
