import { describe, expect, it } from 'vitest';
import { resolvePeriod } from './fleet-period.js';

describe('resolvePeriod', () => {
    it('defaults both ends to the cut-off day', () => {
        expect(resolvePeriod(undefined, undefined, '2026-11-19')).toEqual({ from: '2026-11-19', to: '2026-11-19' });
    });

    it('keeps the dates given', () => {
        expect(resolvePeriod('2026-11-01', '2026-11-19', '2026-11-19')).toEqual({ from: '2026-11-01', to: '2026-11-19' });
    });

    it('rejects from after to and a range over 366 days', () => {
        expect(() => resolvePeriod('2026-11-20', '2026-11-19', '2026-11-19')).toThrow();
        expect(() => resolvePeriod('2025-01-01', '2026-11-19', '2026-11-19')).toThrow();
    });

    it('rejects a lone from that is after the cut-off day it defaults to', () => {
        expect(() => resolvePeriod('2026-11-25', undefined, '2026-11-19')).toThrow();
    });
});
