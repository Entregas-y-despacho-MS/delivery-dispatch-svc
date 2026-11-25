import { describe, expect, it } from 'vitest';
import { DEFAULT_PASSWORD_POLICY, PASSWORD_MIN_LENGTH_FLOOR, missingPasswordRequirements } from './password.validator.js';

describe('missingPasswordRequirements', () => {
    it('accepts a password with every class under the default policy', () => {
        expect(missingPasswordRequirements('Passw0rd!', DEFAULT_PASSWORD_POLICY)).toEqual([]);
    });

    it('names each missing class', () => {
        expect(missingPasswordRequirements('abcdefgh', DEFAULT_PASSWORD_POLICY)).toEqual(['1 uppercase letter', '1 number', '1 special character']);
        expect(missingPasswordRequirements('ABCDEFG1!', DEFAULT_PASSWORD_POLICY)).toEqual(['1 lowercase letter']);
    });

    it('ignores a class the policy no longer requires', () => {
        const policy = { ...DEFAULT_PASSWORD_POLICY, requireSymbol: false, requireNumber: false };
        expect(missingPasswordRequirements('Abcdefgh', policy)).toEqual([]);
    });

    it('treats a space as a symbol and an accented capital as uppercase, like the previous fixed rule', () => {
        expect(missingPasswordRequirements('Año nuevo1', DEFAULT_PASSWORD_POLICY)).toEqual([]);
        expect(missingPasswordRequirements('ÁÑO NUEVO1', DEFAULT_PASSWORD_POLICY)).toEqual(['1 lowercase letter']);
    });

    it('keeps the floor at 8', () => {
        expect(PASSWORD_MIN_LENGTH_FLOOR).toBe(8);
    });
});
