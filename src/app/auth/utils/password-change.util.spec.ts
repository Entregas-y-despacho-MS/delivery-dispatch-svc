import { describe, expect, it } from 'vitest';
import { isPasswordChangeRequired } from './password-change.util.js';

const DAY = 86_400_000;
const NOW = Date.now();

describe('isPasswordChangeRequired', () => {
    it('true when an admin flagged the account, however recent the password', () => {
        expect(isPasswordChangeRequired({ requiresPwdChange: true, passwordChangedAt: new Date(NOW) }, 90, NOW)).toBe(true);
    });
    it('false within the validity period', () => {
        expect(isPasswordChangeRequired({ requiresPwdChange: false, passwordChangedAt: new Date(NOW - 10 * DAY) }, 90, NOW)).toBe(false);
    });
    it('true once older than password_expiration_days, false exactly at the limit', () => {
        expect(isPasswordChangeRequired({ requiresPwdChange: false, passwordChangedAt: new Date(NOW - 91 * DAY) }, 90, NOW)).toBe(true);
        expect(isPasswordChangeRequired({ requiresPwdChange: false, passwordChangedAt: new Date(NOW - 90 * DAY) }, 90, NOW)).toBe(false);
    });
});
