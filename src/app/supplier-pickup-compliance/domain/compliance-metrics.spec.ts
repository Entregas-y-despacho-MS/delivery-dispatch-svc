import { describe, expect, it } from 'vitest';
import { AppointmentCategory as C } from './appointment-classifier.js';
import { buildComplianceMetrics, emptyCounts, originalExpiredBeforeReschedule, type CategoryCounts } from './compliance-metrics.js';

const counts = (overrides: Partial<CategoryCounts> = {}): CategoryCounts => ({ ...emptyCounts(), ...overrides });

describe('buildComplianceMetrics', () => {
    it('numerator over on time + late + failed, with the same n', () => {
        const metrics = buildComplianceMetrics(counts({ [C.ON_TIME]: 6, [C.LATE]: 2, [C.FAILED]: 2 }));
        expect(metrics).toEqual({ numerator: 6, denominator: 10, n: 10, percentage: 60, unavailableReason: null });
    });

    it('keeps pending, open overdue, cancelled and no-appointment out of the denominator', () => {
        const metrics = buildComplianceMetrics(counts({
            [C.ON_TIME]: 1, [C.LATE]: 1, [C.PENDING_NOT_DUE]: 5, [C.OPEN_OVERDUE]: 4, [C.CANCELLED]: 3, [C.NO_VALID_APPOINTMENT]: 2, [C.UNKNOWN_TIMING]: 1,
        }));
        expect(metrics).toMatchObject({ numerator: 1, denominator: 2, n: 2, percentage: 50 });
    });

    it('is N/D (null, not 0) with the cause when there is no expired appointment with a result', () => {
        expect(buildComplianceMetrics(counts())).toMatchObject({ percentage: null, unavailableReason: 'no_valid_results' });
        expect(buildComplianceMetrics(counts({ [C.OPEN_OVERDUE]: 3, [C.PENDING_NOT_DUE]: 2 }))).toMatchObject({ percentage: null, unavailableReason: 'no_valid_results' });
    });

    it('says the timestamp is missing when that is the only thing left', () => {
        expect(buildComplianceMetrics(counts({ [C.UNKNOWN_TIMING]: 2 }))).toMatchObject({ percentage: null, unavailableReason: 'missing_timestamp' });
    });

    it('is 0 only when there are results and none on time', () => {
        expect(buildComplianceMetrics(counts({ [C.FAILED]: 2 })).percentage).toBe(0);
    });

    it('shows 100 only when none is out of the appointment', () => {
        expect(buildComplianceMetrics(counts({ [C.ON_TIME]: 1_999, [C.LATE]: 1 })).percentage).toBe(99.9);
        expect(buildComplianceMetrics(counts({ [C.ON_TIME]: 2_000 })).percentage).toBe(100);
    });
});

describe('originalExpiredBeforeReschedule', () => {
    const at = (iso: string) => new Date(iso);

    it('is true when the original window ended before the first reschedule', () => {
        expect(originalExpiredBeforeReschedule({ originalWindowEnd: at('2026-11-10T16:00:00Z'), firstRescheduleAt: at('2026-11-11T09:00:00Z') })).toBe(true);
    });

    it('is false when it was rescheduled before the original window ended', () => {
        expect(originalExpiredBeforeReschedule({ originalWindowEnd: at('2026-11-10T16:00:00Z'), firstRescheduleAt: at('2026-11-10T08:00:00Z') })).toBe(false);
    });

    it('is false when it was never rescheduled or the original window is unknown', () => {
        expect(originalExpiredBeforeReschedule({ originalWindowEnd: null, firstRescheduleAt: null })).toBe(false);
        expect(originalExpiredBeforeReschedule({ originalWindowEnd: null, firstRescheduleAt: at('2026-11-11T09:00:00Z') })).toBe(false);
    });
});
