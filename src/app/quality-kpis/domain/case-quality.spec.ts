import { describe, expect, it } from 'vitest';
import { complaintRateKpi, investigationTimeKpi, ratingKpi, responseRateKpi, summarizeComplaints, type ComplaintCaseRow } from './case-quality.js';
import { KpiUnavailableReason, median } from './kpi.js';

const NOW = new Date('2026-11-24T12:00:00Z');
const at = (iso: string) => new Date(iso);

function row(caseId: number, overrides: Partial<ComplaintCaseRow> = {}): ComplaintCaseRow {
    return { caseId, dispatchId: caseId, openedAt: at('2026-11-20T10:00:00Z'), investigationStartedAt: null, decidedAt: null, ...overrides };
}
const decided = (caseId: number, startMin: number, endMin: number) =>
    row(caseId, { investigationStartedAt: new Date(Date.UTC(2026, 10, 21, 10, startMin)), decidedAt: new Date(Date.UTC(2026, 10, 21, 10, endMin)) });

describe('median', () => {
    it('handles empty, odd and even samples', () => {
        expect(median([])).toBeNull();
        expect(median([5, 1, 3])).toBe(3);
        expect(median([10, 20, 30, 40])).toBe(25);
    });
});

describe('summarizeComplaints / complaintRateKpi', () => {
    it('reference case: 3 cases over 20 delivered dispatches = 15', () => {
        const quality = summarizeComplaints([row(1), row(2), row(3)], NOW);
        const kpi = complaintRateKpi(quality, 20);
        expect([kpi.numerator, kpi.denominator, kpi.n, kpi.value]).toEqual([3, 20, 20, 15]);
    });

    it('counts a repeated case once', () => {
        expect(summarizeComplaints([row(1), row(1)], NOW).caseCount).toBe(1);
    });

    it('counts two cases of one dispatch as two cases on one dispatch', () => {
        const quality = summarizeComplaints([row(1, { dispatchId: 9 }), row(2, { dispatchId: 9 })], NOW);
        expect(quality).toMatchObject({ caseCount: 2, dispatchesWithCaseCount: 1 });
    });

    it('is Sin datos with no delivered dispatch, not a 0', () => {
        expect(complaintRateKpi(summarizeComplaints([], NOW), 0)).toMatchObject({ available: true, value: null });
    });

    it('keeps open cases as a count and age, out of the median', () => {
        const quality = summarizeComplaints([row(1), row(2, { openedAt: at('2026-11-22T12:00:00Z') }), decided(3, 0, 90)], NOW);
        expect(quality.open).toEqual({ count: 2, oldestAgeMinutes: (4 * 24 + 2) * 60 });
        expect(quality.investigationMinutes).toEqual([90]);
    });
});

describe('investigationTimeKpi', () => {
    it('is the median of the cases with both timestamps: (60, 120, 600) → 120', () => {
        const kpi = investigationTimeKpi(summarizeComplaints([decided(1, 0, 60), decided(2, 0, 120), decided(3, 0, 600)], NOW));
        expect(kpi).toMatchObject({ value: 120, n: 3, available: true });
    });

    it('leaves out a decided case with no start timestamp and says so when none is left', () => {
        const noStart = row(1, { decidedAt: at('2026-11-21T12:00:00Z') });
        const quality = summarizeComplaints([noStart], NOW);
        expect(quality.decidedWithoutTimestampsCount).toBe(1);
        expect(investigationTimeKpi(quality)).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.INVESTIGATION_TIMESTAMP_MISSING });
    });

    it('does not turn a decision before the start into a negative time', () => {
        const backwards = row(1, { investigationStartedAt: at('2026-11-21T12:00:00Z'), decidedAt: at('2026-11-21T11:00:00Z') });
        expect(summarizeComplaints([backwards], NOW).investigationMinutes).toEqual([]);
    });

    it('is Sin datos with only open cases', () => {
        expect(investigationTimeKpi(summarizeComplaints([row(1)], NOW))).toMatchObject({ available: true, value: null, n: 0 });
    });
});

describe('ratingKpi / responseRateKpi', () => {
    it('averages the scores with n when authorized: (5, 4, 3) → 4', () => {
        expect(ratingKpi([5, 4, 3])).toMatchObject({ value: 4, n: 3, available: true });
    });

    it('is omitted with its cause, and shows no figure, when not authorized', () => {
        expect(ratingKpi(null)).toMatchObject({ available: false, value: null, n: 0, numerator: null, reason: KpiUnavailableReason.RATING_NOT_AUTHORIZED });
    });

    it('is Sin datos when authorized and nothing was rated', () => {
        expect(ratingKpi([])).toMatchObject({ available: true, value: null, n: 0 });
    });

    it('the response rate is always N/D until the opportunity to answer is recorded', () => {
        expect(responseRateKpi()).toMatchObject({ available: false, value: null, reason: KpiUnavailableReason.RESPONSE_OPPORTUNITY_NOT_RECORDED });
    });
});
