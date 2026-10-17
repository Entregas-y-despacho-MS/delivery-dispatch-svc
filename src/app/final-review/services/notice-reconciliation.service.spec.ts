import { describe, expect, it, vi } from 'vitest';
import { NoticeReconciliationService } from './notice-reconciliation.service.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
};
// Tuesday 2026-10-13 16:30 La Paz: the reminder hour of Wednesday's batches.
const AT_REMINDER = { trigger: 'schedule' as const, occurrence: null, startedAt: new Date('2026-10-13T20:30:00Z') };

const batch = (routeBatchId: number, status: string, shiftDate: string) => ({ routeBatchId, status, shiftDate, reviewerUserId: null, dispatchCount: 0 });
const SUMMARY = { reminders: 1, maintained: 1, skipped: 0, waiting: 0, deferred: 0, failed: 0, errors: 0 };

function build(options: {
    settings?: Record<string, string>; batches?: any[]; abandoned?: Record<number, any[]>;
    abandonResults?: Array<boolean | Error>;
} = {}) {
    const settings = { getString: vi.fn(async (key: string) => (options.settings ?? SETTINGS)[key] ?? '') };
    const results = [...(options.abandonResults ?? [])];
    const scope = {
        abandonNotice: vi.fn(async () => {
            const next = results.length > 0 ? results.shift()! : true;
            if (next instanceof Error) throw next;
            return next;
        }),
    };
    const repository = {
        findBatchesInRange: vi.fn(async () => options.batches ?? []),
        findAbandonedNotices: vi.fn(async (id: number) => (options.abandoned ?? {})[id] ?? []),
        inBatchLock: vi.fn(async (_id: number, work: (s: typeof scope) => Promise<unknown>) => await work(scope)),
    };
    const notices = { sendDueNotices: vi.fn(async () => ({ ...SUMMARY })) };
    return { service: new NoticeReconciliationService(settings as any, repository as any, notices as any), repository, scope, notices };
}

describe('NoticeReconciliationService', () => {
    it('looks at yesterday, today and the next route day', async () => {
        const { service, repository } = build();

        const summary = await service.run(AT_REMINDER);

        expect(repository.findBatchesInRange).toHaveBeenCalledWith('2026-10-12', '2026-10-14', ['confirmed', 'pending_final_review', 'provisional']);
        expect(summary).toMatchObject({ status: 'executed', from: '2026-10-12', to: '2026-10-14' });
    });

    it('on Friday the next route day is Monday', async () => {
        const { service, repository } = build();

        await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-16T20:30:00Z') });

        expect(repository.findBatchesInRange).toHaveBeenCalledWith('2026-10-15', '2026-10-19', expect.anything());
    });

    it('closes an abandoned reservation under the lock of its batch, and counts it', async () => {
        const { service, repository, scope } = build({
            batches: [batch(11, 'pending_final_review', '2026-10-14')],
            abandoned: { 11: [{ routeBatchId: 11, dispatchId: 1, template: 'risk-notice' }] },
        });

        const summary = await service.run(AT_REMINDER);

        expect(repository.inBatchLock).toHaveBeenCalledWith(11, expect.any(Function));
        expect(scope.abandonNotice).toHaveBeenCalledWith(1, 'risk-notice');
        expect(summary.abandoned).toBe(1);
    });

    it('does not count a reservation that was closed meanwhile (the re-check under the lock says no)', async () => {
        const { service } = build({
            batches: [batch(11, 'confirmed', '2026-10-14')],
            abandoned: { 11: [{ routeBatchId: 11, dispatchId: 1, template: 'reminder' }] },
            abandonResults: [false],
        });

        await expect(service.run(AT_REMINDER)).resolves.toMatchObject({ abandoned: 0, abandonedErrors: 0 });
    });

    it('a database error closing one reservation is counted and the next one is still closed', async () => {
        const { service, scope } = build({
            batches: [batch(11, 'confirmed', '2026-10-14')],
            abandoned: { 11: [{ routeBatchId: 11, dispatchId: 1, template: 'reminder' }, { routeBatchId: 11, dispatchId: 2, template: 'reminder' }] },
            abandonResults: [new Error('db down'), true],
        });

        const summary = await service.run(AT_REMINDER);

        expect(summary).toMatchObject({ abandoned: 1, abandonedErrors: 1 });
        expect(scope.abandonNotice).toHaveBeenCalledTimes(2);
    });

    it('decides again only the orders still owed a notice, in confirmed batches whose reminder hour has come', async () => {
        const { service, notices } = build({ batches: [batch(11, 'confirmed', '2026-10-14')] });

        const summary = await service.run(AT_REMINDER);

        expect(notices.sendDueNotices).toHaveBeenCalledWith(11, '2026-10-14', new Date('2026-10-13T20:30:00.000Z'), expect.anything(), { onlyPending: true });
        expect(summary.notices).toMatchObject({ reminders: 1, maintained: 1 });
    });

    it('before the reminder hour it sends nothing, but still closes abandoned reservations', async () => {
        const { service, notices, scope } = build({
            batches: [batch(11, 'confirmed', '2026-10-14')],
            abandoned: { 11: [{ routeBatchId: 11, dispatchId: 1, template: 'risk-notice' }] },
        });

        await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-13T20:28:00Z') });

        expect(notices.sendDueNotices).not.toHaveBeenCalled();
        expect(scope.abandonNotice).toHaveBeenCalledTimes(1);
    });

    it('uses the nearest minute, like the ticker: 16:29:59.9 already is the reminder hour', async () => {
        const { service, notices } = build({ batches: [batch(11, 'confirmed', '2026-10-14')] });

        await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-13T20:29:59.900Z') });

        expect(notices.sendDueNotices).toHaveBeenCalledTimes(1);
    });

    it('never sends notices for an unapproved batch or for a route day that already passed', async () => {
        const { service, notices } = build({
            batches: [batch(11, 'pending_final_review', '2026-10-14'), batch(12, 'provisional', '2026-10-14'), batch(13, 'confirmed', '2026-10-12')],
        });

        await service.run(AT_REMINDER);

        expect(notices.sendDueNotices).not.toHaveBeenCalled();
    });

    it('is blocked, without touching anything, when a time is not configured', async () => {
        const { service, repository } = build({ settings: { ...SETTINGS, route_reminder_time: '' } });

        const summary = await service.run(AT_REMINDER);

        expect(summary.status).toBe('blocked');
        expect(repository.findBatchesInRange).not.toHaveBeenCalled();
    });
});
