import { describe, expect, it } from 'vitest';
import { calculateServiceTerm } from './service-term.js';

describe('calculateServiceTerm', () => {
    it('starts at D1 after local D0 and skips weekends and configured holidays', () => {
        expect(calculateServiceTerm(
            '2026-10-16T22:00:00.000Z', 2, 3,
            new Set([1, 2, 3, 4, 5]), new Set(['2026-10-19']),
        )).toEqual({
            earliestDate: '2026-10-21', latestDate: '2026-10-22',
            minimumOperatingDays: 2, maximumOperatingDays: 3,
        });
    });

    it('rejects invalid configuration instead of producing an incorrect term', () => {
        expect(() => calculateServiceTerm('invalid', 2, 3, new Set([1]), new Set())).toThrow('Invalid commercial confirmation date');
        expect(() => calculateServiceTerm('2026-10-12T14:00:00Z', 3, 2, new Set([1]), new Set())).toThrow('Invalid service term settings');
    });
});
