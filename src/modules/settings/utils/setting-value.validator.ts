// What each known setting accepts. Values are stored as text, and the code that reads them falls back to
// a default when they are not a number — so a bad value used to be accepted silently and then either
// ignored or, worse, obeyed (e.g. a negative inactivity limit closed every session at once).
type Rule = { kind: 'int'; min: number; max: number; unit?: string } | { kind: 'time' };

const MINUTES_PER_WEEK = 7 * 24 * 60;

const RULES: Record<string, Rule> = {
    delivery_window_start:         { kind: 'time' },
    delivery_window_end:           { kind: 'time' },
    max_wait_time_min:             { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    sla_alert_threshold_pct:       { kind: 'int', min: 1, max: 100, unit: 'percent' },
    // The DTO layer already requires at least 8 characters, so a lower minimum could never apply.
    password_min_length:           { kind: 'int', min: 8, max: 128, unit: 'characters' },
    password_expiration_days:      { kind: 'int', min: 1, max: 3650, unit: 'days' },
    otp_code_length:               { kind: 'int', min: 4, max: 10, unit: 'digits' },
    otp_expiry_minutes:            { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    max_failed_login_attempts:     { kind: 'int', min: 1, max: 100, unit: 'attempts' },
    account_lockout_minutes:       { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    password_reset_expiry_minutes: { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    session_inactivity_minutes:    { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    order_reservation_ttl_minutes: { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHOLE_NUMBER = /^\d+$/;

/** Returns why `value` is not valid for `key`, or null when it is (or when the key has no rule). */
export function validateSettingValue(key: string, value: string): string | null {
    const rule = RULES[key];
    if (!rule) return null;

    if (rule.kind === 'time') {
        return TIME.test(value) ? null : `${key} must be a time of day as HH:mm, from 00:00 to 23:59 (e.g. "08:00").`;
    }
    if (!WHOLE_NUMBER.test(value) || Number(value) < rule.min || Number(value) > rule.max) {
        return `${key} must be a whole number of ${rule.unit ?? 'units'} from ${rule.min} to ${rule.max}.`;
    }
    return null;
}
