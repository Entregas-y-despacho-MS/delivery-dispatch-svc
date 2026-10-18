import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, generateVerificationCode, maskEmail } from './verification-code.js';

describe('generateVerificationCode', () => {
    it('is always exactly 6 digits, leading zeros included', () => {
        for (let i = 0; i < 500; i++) expect(generateVerificationCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
    });

    it('is not constant', () => {
        expect(new Set(Array.from({ length: 50 }, generateVerificationCode)).size).toBeGreaterThan(1);
    });
});

describe('maskEmail', () => {
    it('keeps the first letter and the domain', () => {
        expect(maskEmail('customer@example.test')).toBe('c***@example.test');
    });

    it('trims the address and tolerates a one-letter name', () => {
        expect(maskEmail('  a@b.co ')).toBe('a***@b.co');
    });

    it('hides everything when it is not an address', () => {
        expect(maskEmail('not-an-email')).toBe('***');
    });
});
