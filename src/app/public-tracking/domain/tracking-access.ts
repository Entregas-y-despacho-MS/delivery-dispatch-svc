/**
 * Pure rules of the access to the tracking page by tracking code plus a one-time code sent to the registered
 * email (ST-309.1, RF-U14, ES-309). It is the alternative to the link of ST-224.1, not a replacement.
 *
 * The tracking code only says WHO the one-time code is sent to: it is never a credential. Everything the
 * customer can observe (answers, limits, timing) is the same whether the code exists or not, so the limits are
 * keyed by the fingerprint of the normalised code and never by the dispatch.
 */
import { createHash } from 'node:crypto';

/** `DSP-AAAA-NNNNN` (column `VARCHAR(20)`). The counter has 5 digits today; a longer one is tolerated. */
const TRACKING_CODE_FORMAT = /^DSP-\d{4}-\d{5,8}$/;

/** Wrong one-time codes allowed per issued code; the next one burns it and a new one must be requested. */
export const MAX_ACCESS_VERIFY_ATTEMPTS = 5;
/** Codes that may be requested for one tracking code in one window (stops the page from mail-bombing the customer). */
export const MAX_ACCESS_CODE_SENDS = 3;
export const ACCESS_CODE_SEND_WINDOW_SECONDS = 15 * 60;
/** Minimum wait between two requests for the same tracking code. */
export const ACCESS_CODE_COOLDOWN_SECONDS = 60;
/** Verification attempts per tracking code in one window, whatever the issued code: a new code never resets it. */
export const MAX_ACCESS_VERIFY_PER_WINDOW = 10;
export const ACCESS_VERIFY_WINDOW_SECONDS = 15 * 60;

/** 32 random bytes in hex. Anything else cannot be a session and is not even looked up. */
export const ACCESS_SESSION_FORMAT = /^[0-9a-f]{64}$/;

/** Uppercase and trimmed, so `dsp-2026-00001 ` and `DSP-2026-00001` count as the same code and share the same limits. */
export function normalizeTrackingCode(raw: string): string {
    return raw.trim().toUpperCase();
}

/** Anything that is not shaped like a tracking code is answered exactly like an unknown one, without a database read. */
export function isWellFormedTrackingCode(normalized: string): boolean {
    return TRACKING_CODE_FORMAT.test(normalized);
}

/**
 * Fingerprint that names a tracking code in the cache and in the logs. The code itself is never a cache key or a log
 * line, and a malformed code gets a key too, so existing, unknown and malformed codes spend the same counters.
 */
export function trackingCodeFingerprint(normalized: string): string {
    return createHash('sha256').update(normalized).digest('hex');
}

export type TrackingAccessKeyKind = 'code' | 'attempts' | 'verifies' | 'sends' | 'cooldown';

/** Cache key of what is kept per tracking code (by fingerprint). Disjoint from `public-tracking:*:{dispatchId}` and from `dispatch-otp:*`. */
export function accessKey(kind: TrackingAccessKeyKind, fingerprint: string): string {
    return `public-tracking:access:${kind}:${fingerprint}`;
}

/** Cache key of a session, by the SHA-256 of the session (the session itself is never stored). */
export function accessSessionKey(sessionHash: string): string {
    return `public-tracking:access-session:${sessionHash}`;
}

/** Events recorded in `dispatch_events` for a real dispatch. Never the code, the session, the token or the address. */
export const ACCESS_EVENT_CODE_SENT = 'tracking_access_code_sent';
export const ACCESS_EVENT_VERIFIED = 'tracking_access_verified';
export const ACCESS_EVENT_LOCKED = 'tracking_access_locked';
