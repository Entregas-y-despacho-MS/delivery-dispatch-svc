import { describe, expect, it } from 'vitest';
import { evaluateSelfService, type SelfServiceInput } from './self-service.js';

const MIN = 60_000;
const NOTIFIED = new Date('2026-10-17T14:00:00Z');

function input(overrides: Partial<SelfServiceInput> = {}): SelfServiceInput {
    return {
        status: 'scheduled',
        customerConfirmation: 'pending',
        promiseNotifiedAt: NOTIFIED,
        hasContactEmail: true,
        rescheduleAttemptsUsed: 0,
        maxRescheduleAttempts: 2,
        windowMinutes: 720,
        rescheduleConfigured: true,
        now: new Date(NOTIFIED.getTime() + 60 * MIN),
        ...overrides,
    };
}

describe('evaluateSelfService', () => {
    it('is open inside the window with attempts left: the customer can confirm, reschedule or ask', () => {
        expect(evaluateSelfService(input())).toEqual({
            open: true,
            closedReason: null,
            windowClosesAt: new Date(NOTIFIED.getTime() + 720 * MIN),
            rescheduleAttemptsLeft: 2,
            canConfirm: true,
            canReschedule: true,
            canRequestChange: true,
        });
    });

    it('closes exactly when the original window ends, and only the change request remains', () => {
        const closesAt = NOTIFIED.getTime() + 720 * MIN;

        expect(evaluateSelfService(input({ now: new Date(closesAt - 1) })).open).toBe(true);
        expect(evaluateSelfService(input({ now: new Date(closesAt) }))).toMatchObject({
            open: false, closedReason: 'window_elapsed', canConfirm: false, canReschedule: false, canRequestChange: true,
        });
    });

    it('closes after the customer confirmed', () => {
        expect(evaluateSelfService(input({ customerConfirmation: 'confirmed' }))).toMatchObject({
            open: false, closedReason: 'confirmed', canConfirm: false, canReschedule: false, canRequestChange: true,
        });
    });

    it('closes when the attempts are used up', () => {
        expect(evaluateSelfService(input({ customerConfirmation: 'rescheduled', rescheduleAttemptsUsed: 2 }))).toMatchObject({
            open: false, closedReason: 'max_attempts', rescheduleAttemptsLeft: 0, canReschedule: false, canRequestChange: true,
        });
    });

    it('stays open after a first rescheduling while attempts and window remain, but nothing is left to confirm', () => {
        expect(evaluateSelfService(input({ customerConfirmation: 'rescheduled', rescheduleAttemptsUsed: 1 }))).toMatchObject({
            open: true, rescheduleAttemptsLeft: 1, canConfirm: false, canReschedule: true,
        });
    });

    it('never counts a window that did not start: a bounced notice leaves only the change request', () => {
        expect(evaluateSelfService(input({ promiseNotifiedAt: null }))).toMatchObject({
            open: false, closedReason: 'no_valid_notice', windowClosesAt: null,
            canConfirm: false, canReschedule: false, canRequestChange: true,
        });
    });

    it('cannot reschedule without an email to send the code to, but can still confirm', () => {
        expect(evaluateSelfService(input({ hasContactEmail: false }))).toMatchObject({
            open: true, canConfirm: true, canReschedule: false,
        });
    });

    it('cannot reschedule while the warehouse lead time or the code validity are not configured', () => {
        expect(evaluateSelfService(input({ rescheduleConfigured: false }))).toMatchObject({
            open: true, canConfirm: true, canReschedule: false, canRequestChange: true,
        });
    });

    it('offers nothing once a change was requested', () => {
        expect(evaluateSelfService(input({ customerConfirmation: 'change_requested' }))).toMatchObject({
            open: false, closedReason: 'change_requested', canConfirm: false, canReschedule: false, canRequestChange: false,
        });
    });

    it('still lets the customer ask for a change once the batch was assigned', () => {
        expect(evaluateSelfService(input({ status: 'assigned', customerConfirmation: 'confirmed' }))).toMatchObject({
            open: false, closedReason: 'not_open', canRequestChange: true,
        });
    });

    it.each(['pending', 'in_planning', 'out_for_delivery', 'delivered', 'not_delivered', 'cancelled', 'rescheduled'])(
        'offers nothing in state %s',
        (status) => {
            expect(evaluateSelfService(input({ status }))).toMatchObject({
                open: false, closedReason: 'not_open', canConfirm: false, canReschedule: false, canRequestChange: false,
            });
        },
    );

    it('never reports a negative number of attempts left', () => {
        expect(evaluateSelfService(input({ rescheduleAttemptsUsed: 5 })).rescheduleAttemptsLeft).toBe(0);
    });
});
