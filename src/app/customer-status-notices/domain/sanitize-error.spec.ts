import { describe, expect, it } from 'vitest';
import { LAST_ERROR_MAX_LENGTH, sanitizeError } from './sanitize-error.js';

describe('sanitizeError', () => {
    it('keeps the useful part of a provider error', () => {
        expect(sanitizeError('connect ECONNREFUSED 10.0.0.5:587')).toBe('connect ECONNREFUSED 10.0.0.5:587');
    });

    it('uses the class and the message of an Error', () => {
        expect(sanitizeError(new Error('Greeting never received'))).toBe('Error: Greeting never received');
    });

    it('removes the recipient address', () => {
        const clean = sanitizeError('550 5.1.1 <ana.perez@example.com>: Recipient address rejected');
        expect(clean).not.toContain('ana.perez');
        expect(clean).not.toContain('@');
        expect(clean).toContain('[email]');
    });

    it('removes links, so the tracking token in them never reaches the table', () => {
        const clean = sanitizeError('Request to https://api.mailer.test/send?token=abcdef failed; page https://app.test/seguimiento/s3cr3t-tracking-token-value');
        expect(clean).not.toContain('https://');
        expect(clean).not.toContain('s3cr3t');
        expect(clean).toContain('[url]');
    });

    it('removes a long token or key written outside a link', () => {
        const clean = sanitizeError('Invalid API key re_1234567890abcdefGHIJKLMN');
        expect(clean).not.toContain('1234567890');
        expect(clean).toContain('[redacted]');
    });

    it('puts a multi-line error on one line and drops control characters', () => {
        expect(sanitizeError('first\r\nsecond\u0000third')).toBe('first second third');
    });

    it('cuts the error to the width of the column', () => {
        expect(sanitizeError('x '.repeat(500)).length).toBeLessThanOrEqual(LAST_ERROR_MAX_LENGTH);
    });

    it.each([[undefined], [null], [''], ['   '], [{ code: 1 }], [42]])('never returns an empty text for %j', (input) => {
        expect(sanitizeError(input)).toBe('unknown error');
    });
});
