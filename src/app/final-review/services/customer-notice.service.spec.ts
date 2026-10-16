import { describe, expect, it, vi } from 'vitest';
import { parseFinalReviewSettings, type FinalReviewSettings } from '../domain/final-review-timeline.js';
import { CustomerNoticeService } from './customer-notice.service.js';

const settings = parseFinalReviewSettings({
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
}).values as FinalReviewSettings;

const SHIFT = '2026-10-14';
const BEFORE_REMINDER = new Date('2026-10-13T20:29:00Z'); // Tue 16:29 La Paz
const AT_REMINDER = new Date('2026-10-13T20:30:00Z'); // Tue 16:30
const AFTER_RISK = new Date('2026-10-14T13:00:00Z'); // Wed 09:00

const dispatch = (overrides: Record<string, unknown> = {}) => ({
    dispatchId: 1, contactEmail: 'ana@example.com', trackingToken: 'tok-1',
    windowStart: new Date('2026-10-14T12:00:00Z'), windowEnd: new Date('2026-10-14T16:00:00Z'),
    reminderSent: false, riskNoticeSent: false, maintainedSent: false, ...overrides,
});

function build(rows: any[], options: { claim?: boolean[]; mail?: 'sent' | 'bounced' | 'throw' } = {}) {
    const claims = [...(options.claim ?? [])];
    const repository = {
        findNoticeDispatches: vi.fn(async () => rows),
        claimDispatchEvent: vi.fn(async () => (claims.length > 0 ? claims.shift()! : true)),
        recordContactManagement: vi.fn(async () => undefined),
    };
    const mailer = {
        send: vi.fn(async () => {
            if (options.mail === 'throw') throw new Error('smtp down');
            return { status: options.mail ?? 'sent' };
        }),
    };
    const config = { get: vi.fn(() => 'http://web.test/') };
    const service = new CustomerNoticeService(repository as any, mailer as any, config as any);
    return { service, repository, mailer };
}

describe('CustomerNoticeService', () => {
    it('sends the reminder with date, window and tracking link at route_reminder_time', async () => {
        const { service, mailer, repository } = build([dispatch()]);

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 1, maintained: 0, failed: 0 });
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({
            to: 'ana@example.com',
            template: 'reminder',
            context: expect.objectContaining({ trackingUrl: 'http://web.test/seguimiento/tok-1', deliveryDate: expect.any(String), deliveryWindow: expect.stringContaining('–') }),
        }));
        expect(repository.claimDispatchEvent).toHaveBeenCalledWith(1, 'route_reminder_sent', expect.any(String), expect.anything());
    });

    it('sends nothing before route_reminder_time: the 16:30 task will do it', async () => {
        const { service, mailer, repository } = build([dispatch()]);

        const summary = await service.sendDueNotices(5, SHIFT, BEFORE_REMINDER, settings);

        expect(summary.waiting).toBe(1);
        expect(mailer.send).not.toHaveBeenCalled();
        expect(repository.claimDispatchEvent).not.toHaveBeenCalled();
    });

    it('a late approval after the reminder hour sends the normal reminder, before any risk notice', async () => {
        const { service, mailer } = build([dispatch()]);

        await service.sendDueNotices(5, SHIFT, new Date('2026-10-14T10:00:00Z'), settings);

        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'reminder' }));
    });

    it('a late approval after the risk notice sends «tu entrega se mantiene», not the reminder', async () => {
        const { service, mailer, repository } = build([dispatch({ riskNoticeSent: true })]);

        const summary = await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(summary).toMatchObject({ reminders: 0, maintained: 1 });
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ template: 'delivery-maintained' }));
        expect(repository.claimDispatchEvent).toHaveBeenCalledWith(1, 'delivery_maintained_sent', expect.any(String), expect.anything());
    });

    it('never sends what was already sent', async () => {
        const { service, mailer } = build([
            dispatch({ dispatchId: 1, reminderSent: true }),
            dispatch({ dispatchId: 2, riskNoticeSent: true, maintainedSent: true }),
        ]);

        await service.sendDueNotices(5, SHIFT, AFTER_RISK, settings);

        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('does not send when another caller claimed the event first', async () => {
        const { service, mailer } = build([dispatch()], { claim: [false] });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 0, failed: 0 });
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('skips an order without email or tracking link, without claiming anything', async () => {
        const { service, mailer, repository } = build([dispatch({ contactEmail: null }), dispatch({ dispatchId: 2, trackingToken: null })]);

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary.skipped).toBe(2);
        expect(repository.claimDispatchEvent).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it.each(['bounced', 'throw'] as const)('a %s email opens a coordinator follow-up and counts as failed', async (mail) => {
        const { service, repository } = build([dispatch()], { mail });

        const summary = await service.sendDueNotices(5, SHIFT, AT_REMINDER, settings);

        expect(summary).toMatchObject({ reminders: 0, failed: 1 });
        expect(repository.recordContactManagement).toHaveBeenCalledWith(5, 1, expect.stringContaining('coordinator'), expect.objectContaining({ template: 'reminder' }));
    });
});
