import { describe, expect, it } from 'vitest';
import {
    INLINE_MAX_ATTEMPTS, MAX_TOTAL_ATTEMPTS, RECOVERY_DELAYS_MINUTES, classifyDelivery, inlineBackoffMs, nextStepAfterFailure,
} from './delivery-policy.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const minutesLater = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

describe('classifyDelivery', () => {
    it('accepts a sent email', () => expect(classifyDelivery('sent')).toBe('sent'));
    it('treats a bounce as permanent: the recipient was refused', () => expect(classifyDelivery('bounced')).toBe('permanent'));
    it('treats a failure as transient', () => expect(classifyDelivery('failed')).toBe('transient'));
});

describe('inlineBackoffMs', () => {
    it('waits 500 ms after the first failure and 1 s after the second, like the push retry', () => {
        expect(inlineBackoffMs(1)).toBe(500);
        expect(inlineBackoffMs(2)).toBe(1000);
    });

    it('never waits less than the first backoff', () => expect(inlineBackoffMs(0)).toBe(500));
});

describe('nextStepAfterFailure', () => {
    it('allows 3 inline attempts and then 3 recovery attempts, 6 in all', () => {
        expect(INLINE_MAX_ATTEMPTS).toBe(3);
        expect(RECOVERY_DELAYS_MINUTES).toEqual([5, 15, 60]);
        expect(MAX_TOTAL_ATTEMPTS).toBe(6);
    });

    it('schedules the first recovery attempt 5 minutes after the inline attempts failed', () => {
        expect(nextStepAfterFailure(3, NOW)).toEqual({ status: 'retrying', nextAttemptAt: minutesLater(5) });
    });

    it('widens the wait after each failed recovery attempt: 15 and then 60 minutes', () => {
        expect(nextStepAfterFailure(4, NOW)).toEqual({ status: 'retrying', nextAttemptAt: minutesLater(15) });
        expect(nextStepAfterFailure(5, NOW)).toEqual({ status: 'retrying', nextAttemptAt: minutesLater(60) });
    });

    it('stops after the last attempt: exhausted, nothing is scheduled', () => {
        expect(nextStepAfterFailure(6, NOW)).toEqual({ status: 'exhausted', nextAttemptAt: null });
        expect(nextStepAfterFailure(9, NOW)).toEqual({ status: 'exhausted', nextAttemptAt: null });
    });

    it('uses the first delay when fewer than the inline attempts were made (a lease taken over early)', () => {
        expect(nextStepAfterFailure(1, NOW)).toEqual({ status: 'retrying', nextAttemptAt: minutesLater(5) });
    });
});
