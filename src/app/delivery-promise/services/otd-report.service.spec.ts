import { describe, expect, it, vi } from 'vitest';
import { unavailableFirstAttempt } from '../domain/first-attempt.js';
import { OtdReportService } from './otd-report.service.js';

const NOW = new Date('2026-11-20T15:00:00Z');
const COUNTS = { eligible: 10, onTime: 8, invalidWindow: 1, excludedCancellations: 2, unreconstructableCancellations: 0, rescheduledPromise: 3 };

function service(counts = COUNTS) {
    const repository = { countCohort: vi.fn().mockResolvedValue(counts), countDeliveredAt: vi.fn().mockResolvedValue(counts) };
    return { service: new OtdReportService(repository as never), repository };
}

describe('OtdReportService.getPromiseOtd', () => {
    it('answers the rate with its basis, time zone, cut, filters and the N/D of the first attempt', async () => {
        const { service: svc } = service();
        const report = await svc.getPromiseOtd({ from: '2026-11-01', to: '2026-11-30', zoneId: 3 }, NOW);
        expect(report).toMatchObject({
            from: '2026-11-01',
            to: '2026-11-30',
            basis: 'promise',
            dateBasis: 'promise_window_end',
            timeZone: 'America/La_Paz',
            asOf: '2026-11-20T15:00:00.000Z',
            filters: { zoneId: 3, serviceLevelId: null, status: null },
            metrics: { numerator: 8, denominator: 10, n: 10, percentage: 80, invalidWindowCount: 1, rescheduledPromiseCount: 3 },
            firstAttempt: unavailableFirstAttempt(),
            empty: false,
        });
        expect(report.metrics.excludedCancellations).toEqual({ count: 2, reason: 'cancelled_before_promise_expired' });
    });

    it('says «Sin datos» (no rate, empty) when the filters leave nothing', async () => {
        const { service: svc } = service({ eligible: 0, onTime: 0, invalidWindow: 0, excludedCancellations: 0, unreconstructableCancellations: 0, rescheduledPromise: 0 });
        const report = await svc.getPromiseOtd({ from: '2026-11-01', to: '2026-11-30' }, NOW);
        expect(report.metrics.percentage).toBeNull();
        expect(report.empty).toBe(true);
    });

    it('is not empty when only invalid windows or cancellations were found: they are shown apart', async () => {
        const { service: svc } = service({ eligible: 0, onTime: 0, invalidWindow: 2, excludedCancellations: 0, unreconstructableCancellations: 0, rescheduledPromise: 0 });
        const report = await svc.getPromiseOtd({ from: '2026-11-01', to: '2026-11-30' }, NOW);
        expect(report.metrics.percentage).toBeNull();
        expect(report.empty).toBe(false);
    });

    it('rejects an invalid range without touching the database', async () => {
        const { service: svc, repository } = service();
        await expect(svc.getPromiseOtd({ from: '2026-11-30', to: '2026-11-01' }, NOW)).rejects.toMatchObject({ response: { error: 'INVALID_DATE_RANGE' } });
        await expect(svc.getPromiseOtd({ from: '2025-01-01', to: '2026-11-01' }, NOW)).rejects.toMatchObject({ response: { error: 'DATE_RANGE_TOO_LARGE' } });
        expect(repository.countCohort).not.toHaveBeenCalled();
    });
});

describe('OtdReportService.getDeliveredAtOtd / getOtd', () => {
    it('answers the historic punctuality labelled with its own basis, date and exclusion reason', async () => {
        const { service: svc, repository } = service();
        const report = await svc.getDeliveredAtOtd({ from: '2026-11-01', to: '2026-11-30' }, NOW);
        expect(report).toMatchObject({ basis: 'deliveredAt', dateBasis: 'closed_at', metrics: { numerator: 8, denominator: 10 } });
        expect(report.metrics.excludedCancellations.reason).toBe('cancelled_not_a_completed_delivery');
        expect(repository.countDeliveredAt).toHaveBeenCalledTimes(1);
        expect(repository.countCohort).not.toHaveBeenCalled();
    });

    it('chooses the query by basis, the cohort of promise by default', async () => {
        const { service: svc, repository } = service();
        const filters = { from: '2026-11-01', to: '2026-11-30' };
        expect((await svc.getOtd(filters, undefined, NOW)).basis).toBe('promise');
        expect((await svc.getOtd(filters, 'deliveredAt' as never, NOW)).basis).toBe('deliveredAt');
        expect(repository.countCohort).toHaveBeenCalledTimes(1);
        expect(repository.countDeliveredAt).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid range without touching the database', async () => {
        const { service: svc, repository } = service();
        await expect(svc.getDeliveredAtOtd({ from: '2026-11-30', to: '2026-11-01' }, NOW)).rejects.toMatchObject({ response: { error: 'INVALID_DATE_RANGE' } });
        expect(repository.countDeliveredAt).not.toHaveBeenCalled();
    });
});
