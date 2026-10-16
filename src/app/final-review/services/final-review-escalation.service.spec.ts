import { describe, expect, it, vi } from 'vitest';
import { FinalReviewEscalationService } from './final-review-escalation.service.js';
import type { DispatchNoticeState } from './final-review.repository.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
};
// Wednesday 2026-10-14 07:00 La Paz.
const AT_ESCALATION = { trigger: 'schedule' as const, occurrence: 'final-review-escalation@2026-10-14T07:00', startedAt: new Date('2026-10-14T11:00:00Z') };
const EVENT = { kind: 'final_review_escalated', severity: 'exception', detail: {}, occurredAt: '2026-10-14T11:00:00.000Z' };

const batch = (routeBatchId: number, status = 'pending_final_review') => ({ routeBatchId, status, shiftDate: '2026-10-14', reviewerUserId: 3, dispatchCount: 2 });
const state = (dispatchId: number, overrides: Partial<DispatchNoticeState> = {}): DispatchNoticeState => ({
    dispatchId, status: 'scheduled', contactEmail: `c${dispatchId}@example.com`, trackingToken: `tok-${dispatchId}`,
    windowStart: null, windowEnd: null, promiseNotifiedAt: new Date(), reminderSent: false, riskNoticeSent: false,
    maintainedSent: false, escalated: false, ...overrides,
});

interface Options {
    batches?: any[]; ids?: Record<number, number[]>; states?: Record<number, DispatchNoticeState | null>;
    settings?: Record<string, string>; reasonId?: number | null;
    /** Status of the batch each time its lock is taken (the last one repeats). */
    statuses?: string[]; incident?: boolean[]; riskClaim?: boolean[]; batchEvents?: boolean[];
    delivery?: Array<'sent' | 'failed'>; storeThrows?: boolean;
}

function build(options: Options = {}) {
    const settings = { getString: vi.fn(async (key: string) => (options.settings ?? SETTINGS)[key] ?? '') };
    const statuses = [...(options.statuses ?? ['pending_final_review'])];
    const riskClaims = [...(options.riskClaim ?? [])];
    const batchEvents = [...(options.batchEvents ?? [])];
    const delivery = [...(options.delivery ?? [])];
    const calls: string[] = [];
    const manager = { tag: 'tx' };
    const makeScope = (status: string) => ({
        status,
        manager,
        dispatchState: vi.fn(async (id: number) => (options.states ?? {})[id] ?? null),
        claimDispatchEvent: vi.fn(async (_id: number, type: string) => {
            calls.push(`claim:${type}`);
            if (type === 'risk_notice_sent') return riskClaims.length > 0 ? riskClaims.shift()! : true;
            return true;
        }),
        registerIncident: vi.fn(async () => { calls.push('incident'); return 'inc'; }),
        recordBatchEventOnce: vi.fn(async (type: string) => {
            calls.push(`batch:${type}`);
            if (type === 'final_review_escalated') return batchEvents.length > 0 ? batchEvents.shift()! : true;
            return true;
        }),
        recordContactManagementOnce: vi.fn(async () => { calls.push('contact'); }),
    });
    const scopes: Array<ReturnType<typeof makeScope>> = [];
    const repository = {
        findBatches: vi.fn(async () => options.batches ?? []),
        findDispatchIds: vi.fn(async (id: number) => (options.ids ?? {})[id] ?? []),
        findCompanyFailureReasonId: vi.fn(async () => (options.reasonId === undefined ? 9 : options.reasonId)),
        inBatchLock: vi.fn(async (_id: number, work: (s: ReturnType<typeof makeScope>) => Promise<unknown>) => {
            const scope = makeScope(statuses.length > 1 ? statuses.shift()! : statuses[0]);
            scopes.push(scope);
            const result = await work(scope);
            calls.push('commit');
            return result;
        }),
    };
    const notices = { deliver: vi.fn(async () => (delivery.length > 0 ? delivery.shift()! : 'sent')) };
    const alerts = {
        raise: vi.fn(async () => undefined),
        store: vi.fn(async () => { calls.push('store'); if (options.storeThrows) throw new Error('db down'); return EVENT; }),
        announce: vi.fn(() => { calls.push('announce'); }),
    };
    const service = new FinalReviewEscalationService(settings as any, repository as any, notices as any, alerts as any);
    return { service, repository, notices, alerts, calls, scopes, manager };
}

describe('FinalReviewEscalationService', () => {
    it('treats a batch still pending at final_review_escalation_time as case 5.2', async () => {
        const { service, repository, notices, alerts, scopes } = build({
            batches: [batch(11)], ids: { 11: [1, 2] }, states: { 1: state(1), 2: state(2) },
        });

        const summary = await service.run(AT_ESCALATION);

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-14', ['pending_final_review', 'provisional']);
        expect(scopes[0].registerIncident).toHaveBeenCalledWith(1, 9);
        expect(scopes[1].registerIncident).toHaveBeenCalledWith(2, 9);
        expect(notices.deliver).toHaveBeenCalledTimes(2);
        expect(notices.deliver).toHaveBeenCalledWith(11, expect.objectContaining({ dispatchId: 1 }), 'send-risk-notice');
        expect(alerts.store).toHaveBeenCalledWith('final_review_escalated', expect.objectContaining({
            routeBatchId: 11, remnant: false, promisedOrders: 2, incidentsRegistered: 2, riskNoticesSent: 2,
        }), expect.anything());
        expect(summary).toMatchObject({ status: 'executed', shiftDate: '2026-10-14', escalatedBatchIds: [11], incidentsRegistered: 2, riskNoticesSent: 2 });
    });

    it('marks the batch LAST, with its coordinator task and alert in the same transaction, announced after the commit', async () => {
        const { service, calls, alerts, manager } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) } });

        await service.run(AT_ESCALATION);

        // order: the order's own transaction first (claims + incident + notice reservation), then the closing one.
        expect(calls).toEqual([
            'claim:final_review_escalated', 'incident', 'claim:risk_notice_sent', 'commit',
            'batch:final_review_escalated', 'batch:coordinator_task_required', 'store', 'commit', 'announce',
        ]);
        expect((alerts.store.mock.calls[0] as unknown[])[2]).toBe(manager);
    });

    it('a failure storing the alert rolls the marker back and the next run finishes the batch', async () => {
        const { service, alerts } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) }, storeThrows: true });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.failedBatchIds).toEqual([11]);
        expect(summary.escalatedBatchIds).toEqual([]);
        expect(alerts.announce).not.toHaveBeenCalled();
    });

    it('includes the remnants of the cutoff (provisional batches) and marks them', async () => {
        const { service, alerts } = build({ batches: [batch(21, 'provisional')], ids: { 21: [7] }, states: { 7: state(7) }, statuses: ['provisional'] });

        await service.run(AT_ESCALATION);

        expect(alerts.store).toHaveBeenCalledWith('final_review_escalated', expect.objectContaining({ routeBatchId: 21, remnant: true, batchStatus: 'provisional' }), expect.anything());
    });

    it('skips a batch with no order the customer was promised', async () => {
        const { service, scopes, alerts } = build({ batches: [batch(31, 'provisional')], ids: { 31: [] } });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.withoutPromisedOrdersBatchIds).toEqual([31]);
        expect(scopes).toHaveLength(0);
        expect(alerts.store).not.toHaveBeenCalled();
    });

    it('an order approved meanwhile gets no incident and no notice, and the batch is not escalated', async () => {
        const { service, notices, alerts, scopes } = build({
            batches: [batch(11)], ids: { 11: [1, 2] }, states: { 1: state(1), 2: state(2) }, statuses: ['confirmed'],
        });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.approvedMeanwhileBatchIds).toEqual([11]);
        expect(summary.escalatedBatchIds).toEqual([]);
        expect(scopes).toHaveLength(1); // stopped at the first order
        expect(scopes[0].registerIncident).not.toHaveBeenCalled();
        expect(notices.deliver).not.toHaveBeenCalled();
        expect(alerts.store).not.toHaveBeenCalled();
    });

    it('a batch approved after the orders were handled is reported as approved, not as escalated', async () => {
        const { service, alerts } = build({
            batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) }, statuses: ['pending_final_review', 'confirmed'],
        });

        const summary = await service.run(AT_ESCALATION);

        expect(summary).toMatchObject({ escalatedBatchIds: [], alreadyEscalatedBatchIds: [], approvedMeanwhileBatchIds: [11] });
        expect(alerts.store).not.toHaveBeenCalled();
    });

    it('does not register a second incident for an order already escalated, nor repeat its notice', async () => {
        const { service, notices, scopes } = build({
            batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1, { escalated: true, riskNoticeSent: true }) },
        });

        await service.run(AT_ESCALATION);

        expect(scopes[0].registerIncident).not.toHaveBeenCalled();
        expect(scopes[0].claimDispatchEvent).not.toHaveBeenCalled();
        expect(notices.deliver).not.toHaveBeenCalled();
    });

    it('does not warn an order whose «tu entrega se mantiene» already went out', async () => {
        const { service, notices } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1, { maintainedSent: true }) } });

        await service.run(AT_ESCALATION);

        expect(notices.deliver).not.toHaveBeenCalled();
    });

    it('does not send when another caller reserved the risk notice first, and does not count its incident twice', async () => {
        const { service, notices } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) }, riskClaim: [false] });

        const summary = await service.run(AT_ESCALATION);

        expect(notices.deliver).not.toHaveBeenCalled();
        expect(summary.riskNoticesSent).toBe(0);
    });

    it('an order without email gets a coordinator follow-up instead of a notice, but still its incident', async () => {
        const { service, notices, scopes } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1, { contactEmail: null }) } });

        const summary = await service.run(AT_ESCALATION);

        expect(scopes[0].recordContactManagementOnce).toHaveBeenCalledWith(1, 'risk-notice', expect.stringContaining('coordinator'), expect.anything());
        expect(notices.deliver).not.toHaveBeenCalled();
        expect(summary.incidentsRegistered).toBe(1);
    });

    it('a second run does not escalate the batch again: no new alert, no new task', async () => {
        const { service, alerts, calls } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1, { escalated: true, riskNoticeSent: true }) }, batchEvents: [false] });

        const summary = await service.run(AT_ESCALATION);

        expect(summary.alreadyEscalatedBatchIds).toEqual([11]);
        expect(calls).not.toContain('batch:coordinator_task_required');
        expect(alerts.store).not.toHaveBeenCalled();
        expect(alerts.announce).not.toHaveBeenCalled();
    });

    it('counts bounced risk notices as failed', async () => {
        const { service } = build({ batches: [batch(11)], ids: { 11: [1, 2] }, states: { 1: state(1), 2: state(2) }, delivery: ['sent', 'failed'] });

        const summary = await service.run(AT_ESCALATION);

        expect(summary).toMatchObject({ riskNoticesSent: 1, riskNoticesFailed: 1 });
    });

    it('still warns the customers when the incident reason is not seeded', async () => {
        const { service, notices, scopes } = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) }, reasonId: null });

        await service.run(AT_ESCALATION);

        expect(scopes[0].registerIncident).not.toHaveBeenCalled();
        expect(notices.deliver).toHaveBeenCalledTimes(1);
    });

    it('never approves or moves anything: it only touches events, incidents and notices', async () => {
        const { calls } = await (async () => {
            const built = build({ batches: [batch(11)], ids: { 11: [1] }, states: { 1: state(1) } });
            await built.service.run(AT_ESCALATION);
            return built;
        })();

        expect(calls.filter((call) => !call.startsWith('claim:') && !call.startsWith('batch:') && !['incident', 'store', 'commit', 'announce'].includes(call))).toEqual([]);
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
