import { describe, expect, it, vi } from 'vitest';
import { parseFinalReviewSettings, type FinalReviewSettings } from '../domain/final-review-timeline.js';
import { CustomerNoticeService } from './customer-notice.service.js';
import type { DispatchNoticeState } from './final-review.repository.js';

const settings = parseFinalReviewSettings({
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
}).values as FinalReviewSettings;

const SHIFT = '2026-10-14';
const BEFORE_REMINDER = new Date('2026-10-13T20:29:00Z'); // Tue 16:29 La Paz
const AT_REMINDER = new Date('2026-10-13T20:30:00Z'); // Tue 16:30
const AFTER_RISK = new Date('2026-10-14T13:00:00Z'); // Wed 09:00

const state = (overrides: Partial<DispatchNoticeState> = {}): DispatchNoticeState => ({
    dispatchId: 1, status: 'assigned', contactEmail: 'ana@example.com', trackingToken: 'tok-1',
    windowStart: new Date('2026-10-14T12:00:00Z'), windowEnd: new Date('2026-10-14T16:00:00Z'), promiseNotifiedAt: new Date(),
    reminder: 'none', risk: 'none', maintained: 'none', escalated: false, ...overrides,
});

function build(options: {
    states?: Record<number, DispatchNoticeState | null>; batchStatus?: string; reserve?: boolean[];
    mail?: 'sent' | 'bounced' | 'throw'; resultRecordThrows?: boolean; reserveThrowsFor?: number;
} = {}) {
    const states = options.states ?? { 1: state() };
    const reservations = [...(options.reserve ?? [])];
    const scope = {
        status: options.batchStatus ?? 'confirmed',
        dispatchState: vi.fn(async (id: number) => states[id] ?? null),
        reserveNotice: vi.fn(async (id: number) => {
            if (options.reserveThrowsFor === id) throw new Error('db down');
            return reservations.length > 0 ? reservations.shift()! : true;
        }),
        recordContactManagementOnce: vi.fn(async () => undefined),
    };
    const repository = {
        findDispatchIds: vi.fn(async () => Object.keys(states).map(Number)),
        inBatchLock: vi.fn(async (_id: number, work: (s: typeof scope) => Promise<unknown>) => await work(scope)),
        recordNoticeResult: vi.fn(async () => { if (options.resultRecordThrows) throw new Error('db down'); }),
    };
    const mailer = {
        send: vi.fn(async () => {
            if (options.mail === 'throw') throw new Error('smtp down');
            return { status: options.mail ?? 'sent' };
        }),
    };
    const config = { get: vi.fn(() => 'http://web.test/') };
    return { service: new CustomerNoticeService(repository as any, mailer as any, config as any), repository, scope, mailer };
}

describe('CustomerNoticeService.sendDueNotices', () => {
    it('reserves and sends the reminder with date, window and tracking link at route_reminder_time, then records the result', async () => {
        const { service, mailer, scope, repository } = build();

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 1, maintained: 0, failed: 0, errors: 0 });
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({
            to: 'ana@example.com',
            template: 'reminder',
            context: expect.objectContaining({ trackingUrl: 'http://web.test/seguimiento/tok-1', deliveryDate: expect.any(String), deliveryWindow: expect.stringContaining('–') }),
        }));
        expect(scope.reserveNotice).toHaveBeenCalledWith(1, 'reminder', expect.any(String));
        expect(repository.recordNoticeResult).toHaveBeenCalledWith(5, 1, 'reminder', 'sent', expect.any(String));
    });

    it('decides and reserves under the lock of the batch, and sends after it is released', async () => {
        const { service, repository, mailer } = build();
        let mailedInsideLock = false;
        repository.inBatchLock.mockImplementationOnce(async (_id: number, work: any) => {
            const result = await work({
                status: 'confirmed',
                dispatchState: async () => state(),
                reserveNotice: async () => true,
                recordContactManagementOnce: async () => undefined,
            });
            mailedInsideLock = mailer.send.mock.calls.length > 0;
            return result;
        });

        await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(mailedInsideLock).toBe(false);
        expect(mailer.send).toHaveBeenCalledTimes(1);
    });

    it('sends nothing before route_reminder_time: the 16:30 task will do it', async () => {
        const { service, mailer, scope } = build();

        const summary = await service.sendDueNotices(5, SHIFT, BEFORE_REMINDER, settings);

        expect(summary.waiting).toBe(1);
        expect(mailer.send).not.toHaveBeenCalled();
        expect(scope.reserveNotice).not.toHaveBeenCalled();
    });

    it('a late approval after the reminder hour sends the normal reminder, before any risk notice', async () => {
        const { service, mailer } = build();

        await service.sendDueNotices(5, SHIFT, new Date('2026-10-14T10:00:00Z'), settings);

        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'reminder' }));
    });

    it('a late approval after a risk notice that really arrived sends «tu entrega se mantiene», not the reminder', async () => {
        const { service, mailer, scope } = build({ states: { 1: state({ risk: 'sent' }) } });

        const summary = await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(summary).toMatchObject({ reminders: 0, maintained: 1 });
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'delivery-maintained' }));
        expect(scope.reserveNotice).toHaveBeenCalledWith(1, 'delivery-maintained', expect.any(String));
    });

    it('a late approval after a risk notice that failed or was abandoned sends the reminder, never «se mantiene»', async () => {
        const { service, mailer } = build({ states: { 1: state({ risk: 'failed' }) } });

        await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(mailer.send).toHaveBeenCalledTimes(1);
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'reminder' }));
    });

    it('a late approval while the risk notice is still being sent decides nothing: it is deferred', async () => {
        const { service, mailer, scope, repository } = build({ states: { 1: state({ risk: 'in_flight' }) } });

        const summary = await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(summary).toMatchObject({ deferred: 1, reminders: 0, maintained: 0 });
        expect(scope.reserveNotice).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
        expect(repository.recordNoticeResult).not.toHaveBeenCalled();
    });

    it.each(['in_flight', 'sent', 'failed'] as const)('never sends again a reminder that is %s for this batch', async (reminder) => {
        const { service, mailer } = build({ states: { 1: state({ reminder }) } });

        await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('does not send when another caller reserved the email first', async () => {
        const { service, mailer, repository } = build({ reserve: [false] });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 0, failed: 0 });
        expect(mailer.send).not.toHaveBeenCalled();
        expect(repository.recordNoticeResult).not.toHaveBeenCalled();
    });

    it('does nothing for a batch that is no longer confirmed, or an order that is no longer assigned', async () => {
        const pending = build({ batchStatus: 'pending_final_review' });
        await pending.service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);
        expect(pending.scope.dispatchState).not.toHaveBeenCalled();
        expect(pending.mailer.send).not.toHaveBeenCalled();

        const moved = build({ states: { 1: state({ status: 'scheduled' }) } });
        await moved.service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);
        expect(moved.scope.reserveNotice).not.toHaveBeenCalled();
        expect(moved.mailer.send).not.toHaveBeenCalled();
    });

    it.each([
        ['email', { contactEmail: null }],
        ['tracking link', { trackingToken: null }],
    ])('an order without %s opens a coordinator follow-up and reserves nothing', async (_label, overrides) => {
        const { service, mailer, scope } = build({ states: { 1: state(overrides) } });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary.skipped).toBe(1);
        expect(scope.recordContactManagementOnce).toHaveBeenCalledWith(1, 'reminder', expect.stringContaining('coordinator'), expect.objectContaining({ deliveryResult: 'no_contact' }));
        expect(scope.reserveNotice).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it.each(['bounced', 'throw'] as const)('a %s email records that result (and the follow-up) and counts as failed', async (mail) => {
        const { service, repository } = build({ mail });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 0, failed: 1 });
        expect(repository.recordNoticeResult).toHaveBeenCalledWith(5, 1, 'reminder', mail === 'throw' ? 'failed' : 'bounced', expect.stringContaining('coordinator'));
    });

    it('one bad order does not stop the rest: its database error is counted and the next one is sent', async () => {
        const { service, mailer } = build({ states: { 1: state(), 2: state({ dispatchId: 2, contactEmail: 'b@example.com' }) }, reserveThrowsFor: 1 });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ errors: 1, reminders: 1 });
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'b@example.com' }));
    });

    it('a failure while recording the result never throws (the reservation runs out its lease)', async () => {
        const { service } = build({ mail: 'bounced', resultRecordThrows: true });

        await expect(service.sendDueNotices(5, SHIFT, AT_REMINDER, settings)).resolves.toMatchObject({ failed: 1, errors: 0 });
    });
});

describe('CustomerNoticeService.deliver (risk notice)', () => {
    it('sends the risk notice, does not need a tracking link and records the result', async () => {
        const { service, mailer, repository } = build();

        const outcome = await service.deliver(5, state({ trackingToken: null }), 'send-risk-notice');

        expect(outcome).toBe('sent');
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'risk-notice', context: expect.objectContaining({ trackingUrl: '' }) }));
        expect(repository.recordNoticeResult).toHaveBeenCalledWith(5, 1, 'risk-notice', 'sent', expect.any(String));
    });

    it('a bounced risk notice is recorded as bounced, so the customer counts as NOT warned', async () => {
        const { service, repository } = build({ mail: 'bounced' });

        await expect(service.deliver(5, state(), 'send-risk-notice')).resolves.toBe('failed');
        expect(repository.recordNoticeResult).toHaveBeenCalledWith(5, 1, 'risk-notice', 'bounced', expect.stringContaining('coordinator'));
    });
});
