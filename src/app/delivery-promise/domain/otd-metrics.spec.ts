import { describe, expect, it } from 'vitest';
import { buildOtdMetrics, type OtdCounts } from './otd-metrics.js';

const counts = (overrides: Partial<OtdCounts> = {}): OtdCounts => ({
    eligible: 0,
    onTime: 0,
    invalidWindow: 0,
    excludedCancellations: 0,
    unreconstructableCancellations: 0,
    rescheduledPromise: 0,
    ...overrides,
});

describe('buildOtdMetrics', () => {
    it('gives numerator, denominator and sample size of the same universe', () => {
        const metrics = buildOtdMetrics(counts({ eligible: 42, onTime: 35 }));
        expect(metrics).toMatchObject({ numerator: 35, denominator: 42, n: 42, percentage: 83.3, notOnTimeCount: 7 });
    });

    it('has no rate (null, not 0) when nothing is eligible', () => {
        expect(buildOtdMetrics(counts()).percentage).toBeNull();
        expect(buildOtdMetrics(counts({ invalidWindow: 4 })).percentage).toBeNull();
    });

    it('is 0 only when there are eligible dispatches and none on time', () => {
        expect(buildOtdMetrics(counts({ eligible: 5, onTime: 0 })).percentage).toBe(0);
    });

    it('shows 100 only when none is out of the window', () => {
        expect(buildOtdMetrics(counts({ eligible: 2_000, onTime: 1_999 })).percentage).toBe(99.9);
        expect(buildOtdMetrics(counts({ eligible: 2_000, onTime: 2_000 })).percentage).toBe(100);
    });

    it('keeps the invalid windows and the cancellations apart from the rate', () => {
        const metrics = buildOtdMetrics(counts({ eligible: 10, onTime: 5, invalidWindow: 2, excludedCancellations: 3, unreconstructableCancellations: 1 }));
        expect(metrics.percentage).toBe(50);
        expect(metrics.invalidWindowCount).toBe(2);
        expect(metrics.excludedCancellations).toEqual({ count: 3, reason: 'cancelled_before_promise_expired' });
        expect(metrics.unreconstructableCancellationCount).toBe(1);
    });
});

describe('buildOtdMetrics per basis', () => {
    it('gives each basis its own reason for the cancellations left out', () => {
        expect(buildOtdMetrics(counts({ excludedCancellations: 1 })).excludedCancellations.reason).toBe('cancelled_before_promise_expired');
        expect(buildOtdMetrics(counts({ excludedCancellations: 1 }), 'deliveredAt' as never).excludedCancellations.reason).toBe('cancelled_not_a_completed_delivery');
    });
});
