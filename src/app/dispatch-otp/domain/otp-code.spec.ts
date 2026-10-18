import { describe, expect, it } from 'vitest';
import { createOtp, matchesOtp, otpOptions } from './otp-code.js';

describe('delivery OTP cryptography and configuration', () => {
    it('generates the configured digits and stores salted hashes only', async () => {
        const first = await createOtp(8);
        expect(first.code).toMatch(/^\d{8}$/);
        expect(first.hash).not.toContain(first.code);
        expect(await matchesOtp(first.code, first.hash)).toBe(true);
        expect(await matchesOtp('wrong', first.hash)).toBe(false);
        expect(await matchesOtp(first.code + '0', first.hash)).toBe(false);
        const { hashPassword } = await import('../../../shared/utils/crypto.util.js');
        expect(await hashPassword(first.code)).not.toBe(first.hash);
    });
    it('uses safe defaults for missing, fractional or out-of-range settings', () => {
        expect(otpOptions()).toEqual({ length: 6, ttlSeconds: 3600 });
        expect(otpOptions(10, 15)).toEqual({ length: 10, ttlSeconds: 900 });
        expect(otpOptions(2.5, -10)).toEqual({ length: 6, ttlSeconds: 3600 });
        expect(otpOptions(100, Infinity)).toEqual({ length: 6, ttlSeconds: 3600 });
    });
});
