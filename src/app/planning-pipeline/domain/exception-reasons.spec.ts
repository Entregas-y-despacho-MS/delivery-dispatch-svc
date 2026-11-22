import { describe, expect, it } from 'vitest';
import { EXCEPTION_REASONS, exceptionReason } from './exception-reasons.js';

describe('exceptionReason', () => {
    it('has no reason without codes', () => {
        expect(exceptionReason([])).toBeNull();
    });

    it('explains each code with its own unit, kg or m³, never mixed', () => {
        expect(exceptionReason(['capacity_exceeded_kg'])).toContain('(kg)');
        expect(exceptionReason(['capacity_exceeded_m3'])).toContain('(m³)');
        expect(exceptionReason(['capacity_exceeded_kg', 'capacity_exceeded_m3'])).toBe(`${EXCEPTION_REASONS.capacity_exceeded_kg} ${EXCEPTION_REASONS.capacity_exceeded_m3}`);
    });
});
