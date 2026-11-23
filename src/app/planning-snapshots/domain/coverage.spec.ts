import { describe, expect, it } from 'vitest';
import { computeCoverage, pickOfficialCutoff, type CoverageItem, type CutoffRef } from './coverage.js';

const cutoff = (id: number, at: string, triggerType: CutoffRef['triggerType'] = 'scheduled'): CutoffRef => ({ id, cutoffAt: new Date(at), triggerType });
const eligible = (dispatchId: number, confirmed = false): CoverageItem => ({ dispatchId, universeStatus: 'eligible', exclusionCode: null, confirmed });
const excluded = (dispatchId: number, code: string): CoverageItem => ({ dispatchId, universeStatus: 'excluded', exclusionCode: code, confirmed: false });

describe('pickOfficialCutoff', () => {
    it('is the first scheduled cutoff of the day', () => {
        const official = pickOfficialCutoff([cutoff(3, '2026-10-13T19:00:00Z'), cutoff(1, '2026-10-13T15:00:00Z'), cutoff(2, '2026-10-13T17:00:00Z')]);
        expect(official?.id).toBe(1);
    });

    it('never lets a manual run replace the scheduled one, even if it ran earlier', () => {
        expect(pickOfficialCutoff([cutoff(5, '2026-10-13T10:00:00Z', 'manual'), cutoff(6, '2026-10-13T19:00:00Z')])?.id).toBe(6);
    });

    it('breaks a tie by id', () => {
        expect(pickOfficialCutoff([cutoff(8, '2026-10-13T19:00:00Z'), cutoff(7, '2026-10-13T19:00:00Z')])?.id).toBe(7);
    });

    it('is null with only manual runs or none, so the coverage is unknown instead of guessed', () => {
        expect(pickOfficialCutoff([cutoff(1, '2026-10-13T19:00:00Z', 'manual')])).toBeNull();
        expect(pickOfficialCutoff([])).toBeNull();
    });
});

describe('computeCoverage', () => {
    it('counts confirmed over the eligible ones of the same cutoff', () => {
        const result = computeCoverage([eligible(1, true), eligible(2, true), eligible(3), eligible(4)]);
        expect(result).toMatchObject({ eligible: 4, confirmed: 2, pending: 2, coveragePct: 50 });
    });

    it('never counts an excluded dispatch in the denominator, even if it was confirmed later', () => {
        const result = computeCoverage([eligible(1, true), { ...excluded(2, 'cutoff_window_open'), confirmed: true }]);
        expect(result).toMatchObject({ eligible: 1, confirmed: 1, coveragePct: 100, excludedTotal: 1 });
    });

    it('groups the exclusions by code, the most frequent first', () => {
        const result = computeCoverage([
            eligible(1),
            excluded(2, 'cutoff_no_promise'),
            excluded(3, 'cutoff_window_open'),
            excluded(4, 'cutoff_window_open'),
        ]);
        expect(result.excludedByCode).toEqual([
            { code: 'cutoff_window_open', count: 2 },
            { code: 'cutoff_no_promise', count: 1 },
        ]);
    });

    it('rounds the percentage to two decimals', () => {
        expect(computeCoverage([eligible(1, true), eligible(2), eligible(3)]).coveragePct).toBe(33.33);
    });

    it('has no percentage when nothing was eligible: there is nothing to cover', () => {
        expect(computeCoverage([excluded(1, 'cutoff_no_promise')])).toMatchObject({ eligible: 0, confirmed: 0, pending: 0, coveragePct: null, excludedTotal: 1 });
        expect(computeCoverage([])).toMatchObject({ eligible: 0, coveragePct: null, excludedTotal: 0, excludedByCode: [] });
    });

    it('gives the same denominator whatever happens to the dispatches afterwards', () => {
        const atCutoff = [eligible(1), eligible(2), eligible(3)];
        const later = atCutoff.map((item) => ({ ...item, confirmed: true }));
        expect(computeCoverage(later).eligible).toBe(computeCoverage(atCutoff).eligible);
    });
});
