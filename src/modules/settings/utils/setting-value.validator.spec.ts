import { describe, expect, it } from 'vitest';
import { OPERATIONAL_SETTING_SEEDS } from '../settings.constants.js';
import { validateSettingConfiguration, validateSettingValue } from './setting-value.validator.js';

const defaults = Object.fromEntries([
    ['delivery_window_start', '08:00'],
    ['delivery_window_end', '20:00'],
    ...OPERATIONAL_SETTING_SEEDS.map(({ key, value }) => [key, value]),
]);

describe('validateSettingValue', () => {
    it.each([
        ['max_failed_login_attempts', '1'], ['max_failed_login_attempts', '100'],
        ['order_reservation_ttl_minutes', '15'], ['password_min_length', '8'],
        ['sla_alert_threshold_pct', '90'], ['delivery_window_start', '00:00'], ['delivery_window_end', '23:59'],
        ['plan_generation_times', '08:30,13:30'], ['plan_working_days', '1,2,3,4,5'],
        ['plan_non_working_dates', ''], ['plan_non_working_dates', '2026-12-25,2027-01-01'],
        ['stop_service_minutes', '15'], ['planning_margin_pct', '20'],
    ])('accepts %s = %j', (key, value) => {
        expect(validateSettingValue(key, value)).toBeNull();
    });

    it.each([
        ['max_failed_login_attempts', '0'], ['max_failed_login_attempts', '101'], ['max_failed_login_attempts', 'abc'],
        ['password_min_length', '7'], ['account_lockout_minutes', '1.5'],
        ['delivery_window_start', '25:00'], ['delivery_window_end', '08:00:00'],
        ['plan_generation_times', '08:30,noon'], ['plan_generation_times', '08:30,,13:30'], ['plan_generation_times', '08:30,08:30'],
        ['plan_working_days', '1,8'], ['plan_working_days', '1,1'], ['plan_working_days', ''],
        ['plan_non_working_dates', '2026-02-30'], ['plan_non_working_dates', '2026-12-25,'],
        ['stop_service_minutes', ''], ['planning_margin_pct', '101'],
    ])('rejects %s = %j', (key, value) => {
        expect(validateSettingValue(key, value)).toContain(key);
    });

    it('rejects settings without an explicit validation rule', () => {
        expect(validateSettingValue('unregistered_setting', 'anything')).toContain('no validation rule');
    });

    it('keeps validation rules for all current database settings', () => {
        const existingKeys = [
            'delivery_window_start', 'delivery_window_end', 'max_wait_time_min', 'sla_alert_threshold_pct',
            'password_min_length', 'password_expiration_days', 'otp_code_length', 'otp_expiry_minutes',
            'max_failed_login_attempts', 'account_lockout_minutes', 'password_reset_expiry_minutes',
            'session_inactivity_minutes', 'order_reservation_ttl_minutes',
        ];
        for (const key of existingKeys) expect(validateSettingValue(key, '\u0001'), key).not.toBeNull();
    });

    it('keeps a validation rule for every seeded operational setting', () => {
        for (const { key } of OPERATIONAL_SETTING_SEEDS) {
            expect(validateSettingValue(key, '\u0001'), key).not.toBeNull();
        }
    });
});

describe('validateSettingConfiguration', () => {
    it('accepts the initial operational configuration', () => {
        expect(validateSettingConfiguration(defaults)).toBeNull();
    });

    it.each([
        { ...defaults, morning_window_start: '13:00' },
        { ...defaults, afternoon_window_end: '20:30' },
        { ...defaults, service_max_operating_days: '1' },
        { ...defaults, route_cutoff_time: '16:00' },
        { ...defaults, final_review_escalation_time: '08:15' },
    ])('rejects inconsistent cross-setting values', (settings) => {
        expect(validateSettingConfiguration(settings)).not.toBeNull();
    });

    it('validates the two time chains independently', () => {
        const valid = { ...defaults, final_review_escalation_time: '06:30' };
        expect(validateSettingConfiguration(valid)).toBeNull();
        expect(validateSettingConfiguration({ ...valid, route_cutoff_time: '15:30' })).toBeNull();
        expect(validateSettingConfiguration({ ...valid, final_review_escalation_time: '08:15' })).toContain('final_review_escalation_time');
    });
});
