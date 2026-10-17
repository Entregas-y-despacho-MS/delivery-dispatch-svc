import { describe, expect, it, vi } from 'vitest';
import { RouteReminderService } from './route-reminder.service.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
};
const AT_REMINDER = { trigger: 'schedule' as const, occurrence: 'route-reminder@2026-10-13T16:30', startedAt: new Date('2026-10-13T20:30:00Z') };

function build(batches: Array<{ routeBatchId: number }> = [], settings: Record<string, string> = SETTINGS) {
    const settingsService = { getString: vi.fn(async (key: string) => settings[key] ?? '') };
    const repository = { findBatches: vi.fn(async () => batches) };
    const notices = { sendDueNotices: vi.fn(async () => ({ reminders: 2, maintained: 0, skipped: 1, waiting: 0, failed: 0, errors: 0 })) };
    const alerts = { raise: vi.fn(async () => undefined) };
    const service = new RouteReminderService(settingsService as any, repository as any, notices as any, alerts as any);
    return { service, repository, notices, alerts };
}

describe('RouteReminderService', () => {
    it('reminds only the customers of confirmed batches of the next route day', async () => {
        const { service, repository, notices } = build([{ routeBatchId: 11 }, { routeBatchId: 12 }]);

        const summary = await service.run(AT_REMINDER);

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-14', ['confirmed']);
        expect(notices.sendDueNotices).toHaveBeenCalledTimes(2);
        expect(notices.sendDueNotices).toHaveBeenCalledWith(11, '2026-10-14', new Date('2026-10-13T20:30:00.000Z'), expect.anything());
        expect(summary).toMatchObject({ status: 'executed', shiftDate: '2026-10-14', batchIds: [11, 12], totals: { reminders: 4, skipped: 2 } });
    });

    it('evaluates the nearest minute the ticker saw: 16:29:59.9 is 16:30, not "too early"', async () => {
        const { service, notices } = build([{ routeBatchId: 11 }]);

        await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-13T20:29:59.900Z') });

        expect(notices.sendDueNotices).toHaveBeenCalledWith(11, '2026-10-14', new Date('2026-10-13T20:30:00.000Z'), expect.anything());
    });

    it('reads no pending_final_review batch: its customers get no normal reminder', async () => {
        const { service, repository } = build([]);

        await service.run(AT_REMINDER);

        const statuses = (repository.findBatches.mock.calls[0] as unknown[])[1] as string[];
        expect(statuses).not.toContain('pending_final_review');
        expect(statuses).not.toContain('provisional');
    });

    it('works on Monday\'s batches when run on Friday', async () => {
        const { service, repository } = build([]);

        await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-16T20:30:00Z') });

        expect(repository.findBatches).toHaveBeenCalledWith('2026-10-19', ['confirmed']);
    });

    it('does nothing on a day that is nobody\'s D-1 (Sunday)', async () => {
        const { service, repository, notices } = build([{ routeBatchId: 11 }]);

        const summary = await service.run({ ...AT_REMINDER, startedAt: new Date('2026-10-18T20:30:00Z') });

        expect(summary.status).toBe('not_reminder_day');
        expect(repository.findBatches).not.toHaveBeenCalled();
        expect(notices.sendDueNotices).not.toHaveBeenCalled();
    });

    it('blocks and raises settings_missing when a time is not configured', async () => {
        const { service, notices, alerts } = build([{ routeBatchId: 11 }], { ...SETTINGS, route_reminder_time: '' });

        const summary = await service.run(AT_REMINDER);

        expect(summary.status).toBe('blocked');
        expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.objectContaining({ missingKeys: ['route_reminder_time'] }));
        expect(notices.sendDueNotices).not.toHaveBeenCalled();
    });
});
