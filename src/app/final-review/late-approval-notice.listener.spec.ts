import { describe, expect, it, vi } from 'vitest';
import { LateApprovalNoticeListener } from './late-approval-notice.listener.js';

const SETTINGS: Record<string, string> = {
    plan_working_days: '1,2,3,4,5', plan_non_working_dates: '',
    final_review_end_time: '16:00', route_reminder_time: '16:30', final_review_escalation_time: '07:00',
};
const EVENT = { routeId: 11, driverId: 4, vehicleId: 2, dispatchIds: [1, 2], version: 3 };

function build(batch: { routeBatchId: number; status: string; shiftDate: string } | null, settings: Record<string, string> = SETTINGS) {
    const settingsService = { getString: vi.fn(async (key: string) => settings[key] ?? '') };
    const repository = { findBatch: vi.fn(async () => batch) };
    const notices = { sendDueNotices: vi.fn(async () => ({})) };
    return { listener: new LateApprovalNoticeListener(settingsService as any, repository as any, notices as any), notices };
}

const confirmed = { routeBatchId: 11, status: 'confirmed', shiftDate: '2026-10-14' };

describe('LateApprovalNoticeListener', () => {
    it('asks for the notices due at the moment of the approval', async () => {
        const { listener, notices } = build(confirmed);
        const now = new Date('2026-10-14T10:00:00Z');

        await listener.handleRouteAssigned(EVENT, now);

        expect(notices.sendDueNotices).toHaveBeenCalledWith(11, '2026-10-14', now, expect.objectContaining({ routeReminderTime: '16:30' }));
    });

    it('ignores a batch that is not confirmed', async () => {
        const { listener, notices } = build({ ...confirmed, status: 'pending_final_review' });

        await listener.handleRouteAssigned(EVENT, new Date());

        expect(notices.sendDueNotices).not.toHaveBeenCalled();
    });

    it('never fails the approval: an error is swallowed', async () => {
        const { listener, notices } = build(confirmed);
        notices.sendDueNotices.mockRejectedValueOnce(new Error('db down'));

        await expect(listener.handleRouteAssigned(EVENT, new Date())).resolves.toBeUndefined();
    });

    it('does nothing when the settings are missing', async () => {
        const { listener, notices } = build(confirmed, { ...SETTINGS, route_reminder_time: '' });

        await listener.handleRouteAssigned(EVENT, new Date());

        expect(notices.sendDueNotices).not.toHaveBeenCalled();
    });
});
