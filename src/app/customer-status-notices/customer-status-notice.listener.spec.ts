import { describe, expect, it, vi } from 'vitest';
import { CustomerStatusNoticeListener } from './customer-status-notice.listener.js';

const event = { dispatchId: 7, status: 'delivered', previousStatus: 'in_transit', version: 1, updatedAt: '2026-11-19T14:30:00.000Z' };

describe('CustomerStatusNoticeListener', () => {
    it('hands the event to the service', async () => {
        const notices = { handle: vi.fn(async () => 'sent') };
        await new CustomerStatusNoticeListener(notices as any).handle(event);
        expect(notices.handle).toHaveBeenCalledWith(event);
    });

    it('maps the driver incident report to the service and never fails it', async () => {
        const incident = { dispatchId: 7, reportedAt: '2026-11-19T15:00:00.000Z' };
        const ok = { handleIncident: vi.fn(async () => 'sent') };
        await new CustomerStatusNoticeListener(ok as any).handleIncident(incident);
        expect(ok.handleIncident).toHaveBeenCalledWith(incident);

        const broken = { handleIncident: vi.fn(async () => { throw new Error('db down'); }) };
        await expect(new CustomerStatusNoticeListener(broken as any).handleIncident(incident)).resolves.toBeUndefined();
    });

    it('never fails the transition that emitted the event', async () => {
        const notices = { handle: vi.fn(async () => { throw new Error('db down'); }) };
        await expect(new CustomerStatusNoticeListener(notices as any).handle(event)).resolves.toBeUndefined();
    });
});
