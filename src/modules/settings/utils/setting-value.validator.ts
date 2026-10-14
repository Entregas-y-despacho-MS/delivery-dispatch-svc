type Rule =
    | { kind: 'int'; min: number; max: number; unit: string }
    | { kind: 'time' }
    | { kind: 'time-list' }
    | { kind: 'day-list' }
    | { kind: 'date-list'; allowEmpty: boolean };

const MINUTES_PER_WEEK = 7 * 24 * 60;

const RULES: Record<string, Rule> = {
    delivery_window_start:         { kind: 'time' },
    delivery_window_end:           { kind: 'time' },
    max_wait_time_min:             { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    sla_alert_threshold_pct:       { kind: 'int', min: 1, max: 100, unit: 'percent' },
    password_min_length:           { kind: 'int', min: 8, max: 128, unit: 'characters' },
    password_expiration_days:      { kind: 'int', min: 1, max: 3650, unit: 'days' },
    otp_code_length:               { kind: 'int', min: 4, max: 10, unit: 'digits' },
    otp_expiry_minutes:            { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    max_failed_login_attempts:     { kind: 'int', min: 1, max: 100, unit: 'attempts' },
    account_lockout_minutes:       { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    password_reset_expiry_minutes: { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    session_inactivity_minutes:    { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    order_reservation_ttl_minutes: { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    plan_generation_times:         { kind: 'time-list' },
    plan_horizon_days:             { kind: 'int', min: 1, max: 365, unit: 'days' },
    plan_working_days:             { kind: 'day-list' },
    plan_non_working_dates:        { kind: 'date-list', allowEmpty: true },
    plan_min_orders_per_route:     { kind: 'int', min: 1, max: 1000, unit: 'orders' },
    route_cutoff_time:             { kind: 'time' },
    final_review_end_time:         { kind: 'time' },
    route_reminder_time:           { kind: 'time' },
    promise_response_window_minutes: { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    service_min_operating_days:    { kind: 'int', min: 1, max: 7, unit: 'days' },
    service_max_operating_days:    { kind: 'int', min: 1, max: 7, unit: 'days' },
    slot_duration_minutes:         { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    morning_window_start:          { kind: 'time' },
    morning_window_end:            { kind: 'time' },
    afternoon_window_start:        { kind: 'time' },
    afternoon_window_end:          { kind: 'time' },
    stop_service_minutes:          { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    planning_margin_pct:           { kind: 'int', min: 1, max: 100, unit: 'percent' },
    max_reschedule_attempts:       { kind: 'int', min: 1, max: 100, unit: 'attempts' },
    max_delivery_attempts:         { kind: 'int', min: 1, max: 100, unit: 'attempts' },
    reschedule_window_days:        { kind: 'int', min: 1, max: 365, unit: 'days' },
    tracking_token_retention_days: { kind: 'int', min: 1, max: 3650, unit: 'days' },
    incomplete_order_alert_minutes: { kind: 'int', min: 1, max: MINUTES_PER_WEEK, unit: 'minutes' },
    final_review_escalation_time:  { kind: 'time' },
    warehouse_prep_end_time:       { kind: 'time' },
    warehouse_prep_lead_minutes:   { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
    reschedule_code_expiry_minutes: { kind: 'int', min: 1, max: 1440, unit: 'minutes' },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHOLE_NUMBER = /^\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseTime(value: string): number | null {
    if (!TIME.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

function validateList(value: string, key: string, allowEmpty: boolean, validateItem: (item: string) => boolean, expected: string): string | null {
    if (allowEmpty && value === '') return null;
    const items = value.split(',').map((item) => item.trim());
    if (items.some((item) => item.length === 0 || !validateItem(item))) {
        return `${key} must be a comma-separated list of ${expected}.`;
    }
    if (new Set(items).size !== items.length) return `${key} must not contain duplicate values.`;
    return null;
}

function isIsoDate(value: string): boolean {
    if (!ISO_DATE.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateSettingValue(key: string, value: string): string | null {
    const rule = RULES[key];
    if (!rule) return `${key} has no validation rule.`;

    if (rule.kind === 'time') {
        return parseTime(value) !== null ? null : `${key} must be a time of day as HH:mm, from 00:00 to 23:59 (e.g. "08:00").`;
    }
    if (rule.kind === 'time-list') {
        return validateList(value, key, false, (item) => parseTime(item) !== null, 'times in HH:mm format');
    }
    if (rule.kind === 'day-list') {
        return validateList(value, key, false, (item) => /^[1-7]$/.test(item), 'weekdays from 1 to 7');
    }
    if (rule.kind === 'date-list') {
        return validateList(value, key, rule.allowEmpty, isIsoDate, 'valid ISO dates (YYYY-MM-DD)');
    }
    if (!WHOLE_NUMBER.test(value) || Number(value) < rule.min || Number(value) > rule.max) {
        return `${key} must be a whole number of ${rule.unit} from ${rule.min} to ${rule.max}.`;
    }
    return null;
}

export function validateSettingConfiguration(settings: Record<string, string>): string | null {
    const minimumDays = Number(settings.service_min_operating_days);
    const maximumDays = Number(settings.service_max_operating_days);
    if (Number.isFinite(minimumDays) && Number.isFinite(maximumDays) && maximumDays < minimumDays) {
        return 'service_max_operating_days must be greater than or equal to service_min_operating_days.';
    }

    const generalStart = parseTime(settings.delivery_window_start ?? '');
    const generalEnd = parseTime(settings.delivery_window_end ?? '');
    for (const [startKey, endKey] of [['morning_window_start', 'morning_window_end'], ['afternoon_window_start', 'afternoon_window_end']]) {
        const start = parseTime(settings[startKey] ?? '');
        const end = parseTime(settings[endKey] ?? '');
        if (start === null || end === null) continue;
        if (start >= end) return `${startKey} must be earlier than ${endKey}.`;
        if (generalStart !== null && generalEnd !== null && (start < generalStart || end > generalEnd)) {
            return `${startKey} and ${endKey} must be within delivery_window_start and delivery_window_end.`;
        }
    }

    const chains = [
        ['route_cutoff_time', 'final_review_end_time', 'route_reminder_time'],
        ['final_review_escalation_time', 'warehouse_prep_end_time'],
    ];
    for (const chain of chains) {
        const times = chain.map((key) => parseTime(settings[key] ?? ''));
        if (times.some((time) => time === null)) continue;
        for (let index = 1; index < times.length; index++) {
            if (times[index - 1]! >= times[index]!) {
                return `${chain[index - 1]} must be earlier than ${chain[index]}.`;
            }
        }
    }

    return null;
}
