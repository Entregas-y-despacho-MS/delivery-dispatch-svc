import { describe, expect, it } from 'vitest';
import { validateSettingValue } from './setting-value.validator.js';

describe('validateSettingValue', () => {
    it.each([
        ['max_failed_login_attempts', '1'], ['max_failed_login_attempts', '5'], ['max_failed_login_attempts', '100'],
        ['session_inactivity_minutes', '30'], ['session_inactivity_minutes', '10080'],
        ['password_min_length', '8'], ['password_min_length', '128'],
        ['sla_alert_threshold_pct', '90'], ['otp_code_length', '6'],
        ['delivery_window_start', '08:00'], ['delivery_window_end', '23:59'], ['delivery_window_start', '00:00'],
        ['some_future_key', 'anything goes'], // keys without a rule are not second-guessed
    ])('accepts %s = %j', (key, value) => {
        expect(validateSettingValue(key, value)).toBeNull();
    });

    it.each([
        ['max_failed_login_attempts', '0'], ['max_failed_login_attempts', '101'], ['max_failed_login_attempts', 'abc'],
        ['session_inactivity_minutes', '-5'], ['session_inactivity_minutes', '0'], ['session_inactivity_minutes', '10081'],
        ['password_min_length', '7'], ['password_min_length', '0'], ['password_min_length', '129'],
        ['sla_alert_threshold_pct', '101'], ['sla_alert_threshold_pct', '0'],
        ['otp_code_length', '3'], ['otp_code_length', '11'],
        ['account_lockout_minutes', '1.5'], ['account_lockout_minutes', ' 5'], ['account_lockout_minutes', '5 '], ['account_lockout_minutes', '+5'], ['account_lockout_minutes', '1e2'], ['account_lockout_minutes', ''],
        ['delivery_window_start', '25:00'], ['delivery_window_start', '8:00'], ['delivery_window_end', '12:60'], ['delivery_window_end', 'noon'], ['delivery_window_end', '08:00:00'],
    ])('rejects %s = %j', (key, value) => {
        expect(validateSettingValue(key, value)).toEqual(expect.stringContaining(key));
    });

    it('the message states the accepted range', () => {
        expect(validateSettingValue('max_failed_login_attempts', '0')).toBe('max_failed_login_attempts must be a whole number of attempts from 1 to 100.');
        expect(validateSettingValue('delivery_window_start', 'x')).toContain('HH:mm');
    });

    it('covers every setting seeded by the database (a new seeded key should get a rule)', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        let seed: string;
        try { seed = readFileSync(resolve(__dirname, '../../../../../delivery-dispatch-db/schema/settings/data.sql'), 'utf8'); }
        catch { return; } // the db repo is a sibling checkout: skip when it is not there
        const keys = [...seed.matchAll(/\('([a-z_]+)',\s*'/g)].map((m) => m[1]);
        expect(keys.length).toBeGreaterThan(5);
        for (const key of keys) expect(validateSettingValue(key, '\u0001'), `no rule for ${key}`).not.toBeNull();
    });
});
