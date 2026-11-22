import { describe, expect, it, vi } from 'vitest';
import { DeliveryBacklogService } from './delivery-backlog.service.js';

const NOW = new Date('2026-11-20T15:00:00Z');

function service() {
    const repository = {
        countByStatus: vi.fn().mockResolvedValue([{ status: 'assigned', overdue: true, ageRange: 'under_1d', count: 2 }, { status: 'delivered', overdue: false, ageRange: null, count: 5 }]),
        listOpenOverdue: vi.fn().mockResolvedValue([]),
    };
    return { service: new DeliveryBacklogService(repository as never), repository };
}

describe('DeliveryBacklogService.getBacklog', () => {
    it('builds the summary and asks both queries with the same cut', async () => {
        const { service: svc, repository } = service();
        const filters = { from: '2026-11-01', to: '2026-11-30' };
        const result = await svc.getBacklog(filters, 10, NOW);
        expect(result.counts).toMatchObject({ delivered: 5, openOverdue: 2, pending: 0 });
        expect(result.dateBasis).toBe('promise_window_end');
        expect(repository.countByStatus).toHaveBeenCalledWith(filters, NOW);
        expect(repository.listOpenOverdue).toHaveBeenCalledWith(filters, NOW, 10);
    });

    it('uses the default size of the list', async () => {
        const { service: svc, repository } = service();
        await svc.getBacklog({ from: '2026-11-01', to: '2026-11-30' }, undefined, NOW);
        expect(repository.listOpenOverdue.mock.calls[0][2]).toBe(50);
    });

    it('rejects an invalid range without touching the database', async () => {
        const { service: svc, repository } = service();
        await expect(svc.getBacklog({ from: '2026-11-30', to: '2026-11-01' }, 10, NOW)).rejects.toMatchObject({ response: { error: 'INVALID_DATE_RANGE' } });
        expect(repository.countByStatus).not.toHaveBeenCalled();
        expect(repository.listOpenOverdue).not.toHaveBeenCalled();
    });
});
