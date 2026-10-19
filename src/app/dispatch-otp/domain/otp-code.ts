import { randomInt } from 'node:crypto';
import { comparePassword, hashPassword } from '../../../shared/utils/crypto.util.js';

export const OTP_CODE_LENGTH_KEY = 'otp_code_length';
export const OTP_EXPIRY_MINUTES_KEY = 'otp_expiry_minutes';

export function otpOptions(length = 6, expiryMinutes = 60): { length: number; ttlSeconds: number } {
    return {
        length: Number.isInteger(length) && length >= 4 && length <= 10 ? length : 6,
        ttlSeconds: Number.isInteger(expiryMinutes) && expiryMinutes >= 1 && expiryMinutes <= 1440 ? expiryMinutes * 60 : 3600,
    };
}

/** Each digit uses rejection sampling supplied by node:crypto, including leading zeroes. */
export async function createOtp(length = 6): Promise<{ code: string; hash: string }> {
    const options = otpOptions(length);
    const code = Array.from({ length: options.length }, () => String(randomInt(0, 10))).join('');
    return { code, hash: await hashPassword(code) };
}

export async function matchesOtp(code: string, hash: string): Promise<boolean> {
    if (!/^\d{4,10}$/.test(code)) return false;
    return await comparePassword(code, hash);
}
