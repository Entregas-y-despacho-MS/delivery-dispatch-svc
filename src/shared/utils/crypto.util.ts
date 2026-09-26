import { createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';

// bcrypt is intentionally slow (SALT_ROUNDS controls the cost factor).
// This makes brute-force attacks expensive while remaining imperceptible to users (~100ms).
// Each increment of SALT_ROUNDS doubles the computation time. 10 is the industry standard.
const SALT_ROUNDS = 10;

export const hashPassword = async (plainPassword: string): Promise<string> => {
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
};

export const comparePassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
    return bcrypt.compare(plainPassword, hashedPassword);
};

/**
 * Fingerprint of a token, for storing it without keeping the token itself.
 *
 * Not bcrypt on purpose: bcrypt only reads the first 72 bytes of its input, and a JWT's first 72
 * bytes are the header plus the start of the payload — identical for every token of the same user
 * (the `iat`, `jti` and signature come later). Every refresh token of a user then "matched" the
 * stored hash, so a rotated (old) token kept working. SHA-256 covers the whole token, and a
 * high-entropy token does not need a slow hash.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Constant-time comparison of a token against the fingerprint stored by hashToken(). */
export const tokenMatchesHash = (token: string, storedHash: string): boolean => {
    const actual   = Buffer.from(hashToken(token), 'hex');
    const expected = Buffer.from(storedHash, 'hex');
    // Also false for a legacy bcrypt hash left over from before (not valid hex → shorter buffer).
    return actual.length === expected.length && timingSafeEqual(actual, expected);
};
