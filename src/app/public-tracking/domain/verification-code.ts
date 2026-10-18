/**
 * Pure rules of the verification code of the customer's rescheduling (ST-224.1, D-47). It is NOT the delivery
 * OTP: it is sent to the registered email, has its own validity (`reschedule_code_expiry_minutes`) and only
 * opens the choice of a new slot.
 */
import { randomInt } from 'node:crypto';

export const CODE_LENGTH = 6;
/** Wrong guesses allowed per issued code; the next one burns the code and a new one must be requested. */
export const MAX_VERIFY_ATTEMPTS = 5;
/** Codes the customer may ask for in one window; stops the link from being used to mail-bomb the customer. */
export const MAX_CODE_SENDS = 3;
export const CODE_SEND_WINDOW_SECONDS = 15 * 60;

export function generateVerificationCode(): string {
    return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/** `customer@example.test` → `c***@example.test`: enough for the customer to recognise it, not to learn it. */
export function maskEmail(email: string): string {
    const [local, domain] = email.trim().split('@');
    if (!domain) return '***';
    return `${local.charAt(0)}***@${domain}`;
}
