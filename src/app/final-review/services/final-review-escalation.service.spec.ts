import { describe, expect, it, vi } from 'vitest';
import { FinalReviewEscalationService } from './final-review-escalation.service.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
};
// Wednesday 2026-10-14 07:00 La Paz.
const AT_ESCALATION = { trigger: 'schedule' as const, occurrence: 'final-review-escalation@2026-10-14T07:00', startedAt: new Date('2026-10-14T11:00:00Z') };

const batch = (routeBatchId: number, status = 'pending_final_review') => ({ routeBatchId, status, shiftDate: '2026-10-14', reviewerUserId: 3, dispatchCount: 2 });
const order = (dispatchId: number, overrides: Record<string, unknown> = {}) => ({
    dispatchId, contactEmail: `c${dispatchId}@example.com`, trackingToken: `tok-${dispatchId}`, windowStart: null, windowEnd: null,
    reminderSent: false, riskNoticeSent: false, maintainedSent: false, escalated: false, ...overrides,
});

function build(options: {
    batches?: any[]; orders?: Record<number, any[]>; settings?: Record<string, string>;
    reasonId?: number | null; batchEventWritten?: boolean[]; incident?: Array<string | null>; notice?: string[];
} = {}) {
    const settings = { getString: vi.fn(async (key: string) => (options.settings ?? SETTINGS)[key] ?? '') };
    const batchEvents = [...(options.batchEventWritten ?? [])];
    const incidents = [...(options.incident ?? [])];
    const noticeOutcomes = [...(options.notice ?? [])];
    const repository = {
        findBatches: vi.fn(async () => options.batches ?? []),
        findEscalationDispatches: vi.fn(async (id: number) => options.orders?.[id] ?? []),
        findCompanyFailureReasonId: vi.fn(async () => (options.reasonId === undefined ? 9 : options.reasonId)),
        registerCompanyFailure: vi.fn(async () => (incidents.length > 0 ? incidents.shift()! : 'inc-uuid')),
        recordBatchEventOnce: vi.fn(async () => (batchEvents.length > 0 ? batchEvents.shift()! : true)),
    };
    const notices = { sendRiskNotice: vi.fn(async () => (noticeOutcomes.length > 0 ? noticeOutcomes.shift()! : 'sent')) };
    const alerts = { raise: vi.fn(async () => undefined) };
    const service = new FinalReviewEscalationService(settings as any, repository as any, notices as any, alerts as any);
    return { service, repository, notices, alerts };
}

describe('FinalReviewEscalationService', () => {
    it('treats a batch still pending at final_review_escalation_time as case 5.2', async () => {
        const { service, repository, notices, alerts } = build({ batches: [batch(11)], orders: { 11: [order(1), order(2)] } });

        const summary = await service.run(AT_ESCALATION);

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-14', ['pending_final_review', 'provisional']);
        expect(repository.registerCompanyFailure).toHaveBeenCalledTimes(2);
        expect(repository.registerCompanyFailure).toHaveBeenCalledWith(1, 9, expect.objectContaining({ routeBatchId: 11 }));
        expect(notices.sendRiskNotice).toHaveBeenCalledTimes(2);
        expect(alerts.raise).toHaveBeenCalledWith('final_review_escalated', expect.objectContaining({ routeBatchId: 11, remnant: false, promisedOrders: 2, incidentsRegistered: 2, riskNoticesSent: 2 }));
        expect(summary).toMatchObject({ status: 'executed', shiftDate: '2026-10-14', escalatedBatchIds: [11], incidentsRegistered: 2, riskNoticesSent: 2 });
    });

    it('creates the coordinator task and never approves or moves anything', async () => {
        const { service, repository } = build({ batches: [batch(11)], orders: { 11: [order(1)] } });

        await service.run(AT_ESCALATION);

        const types = repository.recordBatchEventOnce.mock.calls.map((call) => (call as unknown[])[1]);
        expect(types).toEqual(['final_review_escalated', 'coordinator_task_required']);
        // The only writes are events/incidents: the repository has no method that approves, assigns or moves.
        expect(Object.keys(repository).sort()).toEqual([
            'findBatches', 'findCompanyFailureReasonId', 'findEscalationDispatches', 'recordBatchEventOnce', 'registerCompanyFailure',
        ]);
    });

    it('includes the remnants of the cutoff (provisional batches) and marks them', async () => {
        const { service, alerts } = build({ batches: [batch(21, 'provisional')], orders: { 21: [order(7)] } });

        await service.run(AT_ESCALATION);

        expect(alerts.raise).toHaveBeenCalledWith('final_review_escalated', expect.objectContaining({ routeBatchId: 21, remnant: true, batchStatus: 'provisional' }));
    });

    it('skips a batch with no order the customer was promised', async () => {
        const { service, repository, alerts } = build({ batches: [batch(31, 'provisional')], orders: { 31: [] } });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.withoutPromisedOrdersBatchIds).toEqual([31]);
        expect(repository.recordBatchEventOnce).not.toHaveBeenCalled();
        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('does not register a second incident for an order already escalated, nor repeat its notice', async () => {
        const { service, repository, notices } = build({
            batches: [batch(11)], orders: { 11: [order(1, { escalated: true, riskNoticeSent: true })] },
        });

        await service.run(AT_ESCALATION);

        expect(repository.registerCompanyFailure).not.toHaveBeenCalled();
        expect(notices.sendRiskNotice).toHaveBeenCalledTimes(1); // the notice service itself skips it (riskNoticeSent)
    });

    it('does not count an incident another caller already wrote', async () => {
        const { service } = build({ batches: [batch(11)], orders: { 11: [order(1)] }, incident: [null] });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.incidentsRegistered).toBe(0);
    });

    it('a second run does not escalate the batch again: no new alert, no new task', async () => {
        const { service, repository, alerts } = build({ batches: [batch(11)], orders: { 11: [order(1)] }, batchEventWritten: [false] });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.alreadyEscalatedBatchIds).toEqual([11]);
        expect(repository.recordBatchEventOnce).toHaveBeenCalledTimes(1);
        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('counts bounced risk notices as failed', async () => {
        const { service } = build({ batches: [batch(11)], orders: { 11: [order(1), order(2)] }, notice: ['sent', 'failed'] });

        const summary = await service.run(AT_ESCALATION);

        expect(summary).toMatchObject({ riskNoticesSent: 1, riskNoticesFailed: 1 });
    });

    it('still warns the customers when the incident reason is not seeded', async () => {
        const { service, repository, notices } = build({ batches: [batch(11)], orders: { 11: [order(1)] }, reasonId: null });

        await service.run(AT_ESCALATION);

        expect(repository.registerCompanyFailure).not.toHaveBeenCalled();
        expect(notices.sendRiskNotice).toHaveBeenCalledTimes(1);
    });

    it('does nothing on a day the company does not operate', async () => {
        const { service, repository } = build({ batches: [batch(11)] });

        const summary = await service.run({ ...AT_ESCALATION, startedAt: new Date('2026-10-17T11:00:00Z') });

        expect(summary.status).toBe('not_escalation_day');
        expect(repository.findBatches).not.toHaveBeenCalled();
    });

    it('blocks and raises settings_missing when a time is not configured', async () => {
        const { service, repository, alerts } = build({ settings: { ...SETTINGS, final_review_escalation_time: '' } });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.status).toBe('blocked');
        expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.objectContaining({ missingKeys: ['final_review_escalation_time'] }));
        expect(repository.findBatches).not.toHaveBeenCalled();
    });
});
