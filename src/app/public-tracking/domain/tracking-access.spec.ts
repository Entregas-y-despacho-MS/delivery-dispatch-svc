import { describe, expect, it } from 'vitest';
import {
    ACCESS_SESSION_FORMAT, accessKey, accessSessionKey, isWellFormedTrackingCode, normalizeTrackingCode, trackingCodeFingerprint,
} from './tracking-access.js';

describe('normalizeTrackingCode', () => {
    it('trims and uppercases', () => {
        expect(normalizeTrackingCode('  dsp-2026-00001 ')).toBe('DSP-2026-00001');
    });
});

describe('isWellFormedTrackingCode', () => {
    it.each(['DSP-2026-00001', 'DSP-2026-123456'])('accepts %s', (code) => {
        expect(isWellFormedTrackingCode(code)).toBe(true);
    });

    it.each(['', 'dsp-2026-00001', 'DSP-26-00001', 'DSP-2026-1', 'DSP-2026-00001; DROP', 'DSP-2026-00001\n', 'XXX-2026-00001', 'a'.repeat(200)])(
        'rejects %j',
        (code) => {
            expect(isWellFormedTrackingCode(code)).toBe(false);
        },
    );
});

describe('trackingCodeFingerprint', () => {
    it('is deterministic, hex and does not contain the code', () => {
        const fingerprint = trackingCodeFingerprint('DSP-2026-00001');
        expect(fingerprint).toBe(trackingCodeFingerprint('DSP-2026-00001'));
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprint).not.toContain('00001');
    });

    it('differs between codes', () => {
        expect(trackingCodeFingerprint('DSP-2026-00001')).not.toBe(trackingCodeFingerprint('DSP-2026-00002'));
    });
});

describe('cache keys', () => {
    it('are namespaced apart from the rescheduling code and from the delivery OTP', () => {
        const fingerprint = trackingCodeFingerprint('DSP-2026-00001');
        for (const kind of ['code', 'attempts', 'verifies', 'sends', 'cooldown'] as const) {
            const key = accessKey(kind, fingerprint);
            expect(key.startsWith('public-tracking:access:')).toBe(true);
            expect(key).not.toMatch(/^dispatch-otp:/);
            expect(key).not.toContain('DSP-');
        }
        expect(accessSessionKey('ab')).toBe('public-tracking:access-session:ab');
    });
});

describe('ACCESS_SESSION_FORMAT', () => {
    it('only accepts 64 lowercase hex characters', () => {
        expect(ACCESS_SESSION_FORMAT.test('a'.repeat(64))).toBe(true);
        expect(ACCESS_SESSION_FORMAT.test('A'.repeat(64))).toBe(false);
        expect(ACCESS_SESSION_FORMAT.test('DSP-2026-00001')).toBe(false);
        expect(ACCESS_SESSION_FORMAT.test('a'.repeat(63))).toBe(false);
    });
});
