import type { MailDeliveryStatus } from '../../../plugins/mailer/mailer.port.js';

/** Attempts made in the same process right away: the same policy as the push retry (`push-retry.ts`). */
export const INLINE_MAX_ATTEMPTS = 3;
const INLINE_INITIAL_BACKOFF_MS = 500;

/** Minutes to wait before each attempt made by the recovery task, after the inline ones failed. */
export const RECOVERY_DELAYS_MINUTES: readonly number[] = [5, 15, 60];

/** Attempts of one email in all: the inline ones plus one per recovery delay. Past that it is `exhausted`. */
export const MAX_TOTAL_ATTEMPTS = INLINE_MAX_ATTEMPTS + RECOVERY_DELAYS_MINUTES.length;

/** How long an attempt owns its row. A lease that ran out means the process died or hung: the recovery task takes it over. */
export const ATTEMPT_LEASE_MINUTES = 10;

export type DeliveryClass = 'sent' | 'permanent' | 'transient';

/**
 * `bounced` is the provider refusing the recipient: trying again cannot help. `failed` (transport down, timeout,
 * a thrown error) may pass, so it is retried; the cap on attempts keeps it from being retried forever.
 */
export function classifyDelivery(status: MailDeliveryStatus): DeliveryClass {
    if (status === 'sent') return 'sent';
    return status === 'bounced' ? 'permanent' : 'transient';
}

/** Wait before the next inline attempt, given how many inline attempts already failed (500 ms, 1 s). */
export function inlineBackoffMs(failedInlineAttempts: number): number {
    return INLINE_INITIAL_BACKOFF_MS * 2 ** (Math.max(1, failedInlineAttempts) - 1);
}

export type NextStep =
    | { status: 'retrying'; nextAttemptAt: Date }
    | { status: 'exhausted'; nextAttemptAt: null };

/** What a transient failure leads to, given the attempts made so far (all of them, inline and recovery). */
export function nextStepAfterFailure(attemptsMade: number, now: Date): NextStep {
    if (attemptsMade >= MAX_TOTAL_ATTEMPTS) return { status: 'exhausted', nextAttemptAt: null };
    const index = Math.min(Math.max(attemptsMade - INLINE_MAX_ATTEMPTS, 0), RECOVERY_DELAYS_MINUTES.length - 1);
    return { status: 'retrying', nextAttemptAt: new Date(now.getTime() + RECOVERY_DELAYS_MINUTES[index]! * 60_000) };
}
