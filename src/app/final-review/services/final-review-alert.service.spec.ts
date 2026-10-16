import { describe, expect, it, vi } from 'vitest';
import { FinalReviewAlertService } from './final-review-alert.service.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5',
    plan_non_working_dates: '',
    final_review_end_time: '16:00',
    route_reminder_time: '16:30',
    final_review_escalation_time: '07:00',
};

function build(options: { settings?: Record<string, string>; batches?: any[]; written?: boolean[] } = {}) {
    const settings = { getString: vi.fn(async (key: string) => (options.settings ?? SETTINGS)[key] ?? '') };
    const written = [...(options.written ?? [])];
    const repository = {
        findBatches: vi.fn(async () => options.batches ?? []),
        recordBatchEventOnce: vi.fn(async () => (written.length > 0 ? written.shift()! : true)),
    };
    const alerts = { raise: vi.fn(async () => undefined) };
    const service = new FinalReviewAlertService(settings as any, repository as any, alerts as any);
    return { service, repository, alerts };
}

const batch = (routeBatchId: number) => ({ routeBatchId, status: 'pending_final_review', shiftDate: '2026-10-14', reviewerUserId: 3, dispatchCount: 4 });
// Tuesday 2026-10-13 16:00 La Paz.
const AT_REVIEW_END = { trigger: 'schedule' as const, occurrence: 'final-review-alert@2026-10-13T16:00', startedAt: new Date('2026-10-13T20:00:00Z') };

describe('FinalReviewAlertService', () => {
    it('alerts coordinators and the supervisor about a batch still pending at final_review_end_time', async () => {
        const { service, repository, alerts } = build({ batches: [batch(11)] });

        const summary = await service.run(AT_REVIEW_END);

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-14', ['pending_final_review']);
        expect(summary).toMatchObject({ status: 'executed', shiftDate: '2026-10-14', alertedBatchIds: [11] });
        expect(alerts.raise).toHaveBeenCalledWith('final_review_overdue', expect.objectContaining({
            routeBatchId: 11, shiftDate: '2026-10-14', dispatchCount: 4, audience: ['coordinators', 'supervisor'],
        }));
    });

    it('records the event before raising the alert and only for pending batches', async () => {
        const { service, repository } = build({ batches: [batch(11)] });

        await service.run(AT_REVIEW_END);

        expect(repository.recordBatchEventOnce).toHaveBeenCalledWith(
            11, 'final_review_alerted', ['pending_final_review'], expect.any(String), expect.objectContaining({ routeBatchId: 11 }),
        );
    });

    it('does not alert twice: a batch that already has its event is reported and skipped', async () => {
        const { service, alerts } = build({ batches: [batch(11), batch(12)], written: [false, true] });

        const summary = await service.run(AT_REVIEW_END);

        expect(summary.alreadyAlertedBatchIds).toEqual([11]);
        expect(summary.alertedBatchIds).toEqual([12]);
        expect(alerts.raise).toHaveBeenCalledTimes(1);
    });

    it('stays silent when every batch was approved (nothing is pending)', async () => {
        const { service, alerts } = build({ batches: [] });

        const summary = await service.run(AT_REVIEW_END);

        expect(summary).toMatchObject({ status: 'executed', alertedBatchIds: [] });
        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('does nothing on a day that is nobody\'s D-1 (Saturday)', async () => {
        const { service, repository, alerts } = build({ batches: [batch(11)] });

        const summary = await service.run({ ...AT_REVIEW_END, startedAt: new Date('2026-10-17T20:00:00Z') });

        expect(summary).toMatchObject({ status: 'not_review_day', shiftDate: null });
        expect(repository.findBatches).not.toHaveBeenCalled();
        expect(alerts.raise).not.toHaveBeenCalled();
    });

    it('on Friday it looks at Monday\'s batches', async () => {
        const { service, repository } = build({ batches: [] });

        await service.run({ ...AT_REVIEW_END, startedAt: new Date('2026-10-16T20:00:00Z') });

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-19', ['pending_final_review']);
    });

    it('blocks and raises settings_missing when a time is not configured, without touching any batch', async () => {
        const { service, repository, alerts } = build({ settings: { ...SETTINGS, final_review_end_time: '' } });

        const summary = await service.run(AT_REVIEW_END);

        expect(summary.status).toBe('blocked');
        expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.objectContaining({ missingKeys: ['final_review_end_time'] }));
        expect(repository.findBatches).not.toHaveBeenCalled();
    });
});
