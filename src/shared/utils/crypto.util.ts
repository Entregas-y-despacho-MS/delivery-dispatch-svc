import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';

// bcrypt is intentionally slow (SALT_ROUNDS controls the cost factor).
// This makes brute-force attacks expensive while remaining imperceptible to users (~100ms).
// Each increment of SALT_ROUNDS doubles the computation time. 10 is the industry standard.
const SALT_ROUNDS = 10;

/**
 * bcrypt only reads the first 72 bytes of its input, so on its own it accepts any text that shares them with the
 * password. The text is therefore reduced first to its HMAC-SHA-384 (64 base64 characters, no NUL byte), which
 * depends on all of it. The prefix tells these hashes apart from the older ones, made by bcrypt on the text itself.
 */
const PREHASH_PREFIX = 'bcrypt-sha384:';
// Not a secret: it only separates this use of SHA-384, so a plain SHA-384 leaked elsewhere cannot be tried against
// these hashes. Changing it invalidates every stored password.
const PREHASH_KEY = 'delivery-dispatch-svc/password-prehash/v1';
// An older hash cannot say how long its text was. From 72 bytes on, the text could be the cut-off start of a longer
// one; at 71 or less, bcrypt reads all of it plus its terminator, so a longer password does not match it.
const LEGACY_MAX_BYTES = 71;

const prehash = (text: string): string => createHmac('sha384', PREHASH_KEY).update(text, 'utf8').digest('base64');

/**
 * False for text that cannot be told apart from another one: with a NUL byte, with a lone UTF-16 surrogate (encoding
 * to UTF-8 turns every one of them into U+FFFD), or with U+FFFD itself, which is also what the request parser puts in
 * place of any byte that is not valid UTF-8.
 */
export const isHashableText = (text: string): boolean => !/[\0\uFFFD\p{Surrogate}]/u.test(text);

const canMatchLegacyHash = (text: string): boolean =>
    isHashableText(text) && Buffer.byteLength(text, 'utf8') <= LEGACY_MAX_BYTES;

export const hashPassword = async (plainPassword: string): Promise<string> => {
    if (!isHashableText(plainPassword)) throw new Error('Cannot hash text with a NUL byte, a lone surrogate or U+FFFD.');
    return PREHASH_PREFIX + await bcrypt.hash(prehash(plainPassword), SALT_ROUNDS);
};

/**
 * Hash of a short code the server generates (OTP, access and verification codes): far below bcrypt's 72 bytes, so it
 * is bcrypt on the code itself. Checked with comparePassword(). Never for a password a person chooses.
 */
export const hashShortCode = async (code: string): Promise<string> => bcrypt.hash(code, SALT_ROUNDS);

/**
 * True only if `plainPassword` is the text behind `hashedPassword`. It always runs one bcrypt comparison, also when
 * the answer is already "no", so the response time does not depend on why it failed.
 */
export const comparePassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
    if (hashedPassword.startsWith(PREHASH_PREFIX)) {
        const matches = await bcrypt.compare(prehash(plainPassword), hashedPassword.slice(PREHASH_PREFIX.length));
        return matches && isHashableText(plainPassword);
    }
    const matches = await bcrypt.compare(plainPassword, hashedPassword);
    return matches && canMatchLegacyHash(plainPassword);
};

/**
 * For the reuse check only, never to authenticate. It errs the other way: against an older hash, whatever bcrypt
 * takes as equal counts as already used. Otherwise a long password stored that way could be set again.
 */
export const wasPasswordUsed = async (plainPassword: string, hashedPassword: string): Promise<boolean> =>
    hashedPassword.startsWith(PREHASH_PREFIX)
        ? comparePassword(plainPassword, hashedPassword)
        : bcrypt.compare(plainPassword, hashedPassword);

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
