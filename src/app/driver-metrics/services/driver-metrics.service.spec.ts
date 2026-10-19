import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverMetricsPeriod } from '../domain/metrics-period.js';
import type { DriverMetricsRow } from '../repositories/driver-metrics.repository.js';
import { DriverMetricsService } from './driver-metrics.service.js';

const NOW = new Date('2026-10-21T15:00:00Z'); // Wednesday

describe('DriverMetricsService.compute', () => {
    const repository = { aggregate: vi.fn() };
    let service: DriverMetricsService;
    const rows = (row: Partial<DriverMetricsRow>): void => {
        repository.aggregate.mockResolvedValue({ deliveredCount: 0, onTimeCount: 0, assignedCount: 0, ratingsCount: 0, ratingAverage: null, ...row });
    };

    beforeEach(() => {
        repository.aggregate.mockReset();
        service = new DriverMetricsService(repository as never);
    });

    it('turns the totals of the sample week into the figures of the app', async () => {
        rows({ deliveredCount: 12, onTimeCount: 11, assignedCount: 14, ratingsCount: 8, ratingAverage: 4.625 });

        await expect(service.compute(7, DriverMetricsPeriod.WEEK, NOW)).resolves.toEqual({
            period: 'week', from: '2026-10-19', to: '2026-10-21',
            deliveredCount: 12, onTimePercentage: 91.7, assignedCount: 14, rating: 4.6, ratingsCount: 8,
        });
        expect(repository.aggregate).toHaveBeenCalledWith(7, { from: '2026-10-19', to: '2026-10-21' });
    });

    it('a driver with no history gets zeros and no rating, so the app shows the neutral 5.0', async () => {
        rows({});

        await expect(service.compute(9, DriverMetricsPeriod.TODAY, NOW)).resolves.toEqual({
            period: 'today', from: '2026-10-21', to: '2026-10-21',
            deliveredCount: 0, onTimePercentage: 0, assignedCount: 0, rating: null, ratingsCount: 0,
        });
    });

    it('assigned dispatches without any delivery give 0 % on time, never a division by zero', async () => {
        rows({ assignedCount: 5 });

        const metrics = await service.compute(9, DriverMetricsPeriod.TODAY, NOW);

        expect(metrics.onTimePercentage).toBe(0);
        expect(metrics.assignedCount).toBe(5);
    });

    it('deliveries outside their window lower the percentage', async () => {
        rows({ deliveredCount: 3, onTimeCount: 1, assignedCount: 3 });

        expect((await service.compute(7, DriverMetricsPeriod.MONTH, NOW)).onTimePercentage).toBe(33.3);
    });

    it('a null average is never shown as a rating, even if the count says otherwise', async () => {
        rows({ deliveredCount: 1, ratingsCount: 1, ratingAverage: null });

        expect((await service.compute(7, DriverMetricsPeriod.TODAY, NOW)).rating).toBeNull();
    });
});
