/**
 * The settings the plan generator needs and what happens when they are not there (ST-50.2, §2.3 of
 * the plan, docs/decisiones-planificacion-semiautomatica.md §6.4).
 *
 * - A mandatory key that is absent, empty or invalid **blocks** the generator: nothing is written.
 * - `plan_non_working_dates` empty is accepted (no holidays) but **warns**.
 * - `plan_min_orders_per_route` only **warns** later, when a batch is smaller (D-13); it never blocks.
 *
 * Pure parsing over raw strings; `loadPlanningSettings` only needs something with `getString`
 * (SettingsService), so nothing here depends on Nest or the database.
 */
import {
    validateSettingConfiguration,
    validateSettingValue,
} from '../../../modules/settings/utils/setting-value.validator.js';
import { minutesOfDay, type OperatingCalendar, type PromiseDateRules } from './operating-calendar.js';

/** Keys whose absence (or `''`) blocks the generator. */
export const REQUIRED_PLANNING_KEYS = [
    'stop_service_minutes',
    'planning_margin_pct',
    'plan_working_days',
    'service_min_operating_days',
    'service_max_operating_days',
    'route_cutoff_time',
    'promise_response_window_minutes',
    'slot_duration_minutes',
    'morning_window_start',
    'morning_window_end',
    'afternoon_window_start',
    'afternoon_window_end',
] as const;

/** Read for the cross-key consistency check only (delivery window bounds the two route windows). */
const CONTEXT_KEYS = ['delivery_window_start', 'delivery_window_end'] as const;

const OPTIONAL_KEYS = ['plan_non_working_dates', 'plan_min_orders_per_route'] as const;

export const PLANNING_SETTING_KEYS: readonly string[] = [
    ...REQUIRED_PLANNING_KEYS,
    ...OPTIONAL_KEYS,
    ...CONTEXT_KEYS,
];

export type RawSettings = Record<string, string | null | undefined>;

export interface TimeWindow {
    /** `HH:mm` */
    start: string;
    /** `HH:mm` */
    end: string;
}

export interface PlanningSettings {
    stopServiceMinutes: number;
    planningMarginPct: number;
    calendar: OperatingCalendar;
    promiseRules: PromiseDateRules;
    slotDurationMinutes: number;
    morningWindow: TimeWindow;
    afternoonWindow: TimeWindow;
    /** `null` when the key is not configured: no minimum to warn about. */
    minOrdersPerRoute: number | null;
}

export type PlanningSettingsWarning = 'holidays_not_configured';

export interface PlanningSettingsResult {
    ok: boolean;
    values: PlanningSettings | null;
    /** Mandatory keys that are absent or empty. */
    missingKeys: string[];
    /** Keys with a value that does not pass the setting rule. */
    invalidKeys: string[];
    /** A cross-key inconsistency (windows out of order, D_max before D_min...), when there is one. */
    configurationProblem: string | null;
    warnings: PlanningSettingsWarning[];
}

function isBlank(value: string | null | undefined): boolean {
    return value === null || value === undefined || value.trim() === '';
}

function split(value: string): string[] {
    return value.split(',').map((item) => item.trim());
}

export function parsePlanningSettings(raw: RawSettings): PlanningSettingsResult {
    const missingKeys: string[] = [];
    const invalidKeys: string[] = [];
    const warnings: PlanningSettingsWarning[] = [];

    for (const key of REQUIRED_PLANNING_KEYS) {
        const value = raw[key];
        if (isBlank(value)) missingKeys.push(key);
        else if (validateSettingValue(key, value!.trim()) !== null) invalidKeys.push(key);
    }

    const holidaysRaw = raw.plan_non_working_dates;
    const holidaysBlank = isBlank(holidaysRaw);
    if (!holidaysBlank && validateSettingValue('plan_non_working_dates', holidaysRaw!.trim()) !== null) {
        invalidKeys.push('plan_non_working_dates');
    }
    if (holidaysBlank) warnings.push('holidays_not_configured');

    const minOrdersRaw = raw.plan_min_orders_per_route;
    const minOrdersBlank = isBlank(minOrdersRaw);
    if (!minOrdersBlank && validateSettingValue('plan_min_orders_per_route', minOrdersRaw!.trim()) !== null) {
        invalidKeys.push('plan_min_orders_per_route');
    }

    if (missingKeys.length > 0 || invalidKeys.length > 0) {
        return { ok: false, values: null, missingKeys, invalidKeys, configurationProblem: null, warnings };
    }

    const get = (key: string): string => raw[key]!.trim();
    const configurationProblem = findConfigurationProblem(raw, get);
    if (configurationProblem) {
        return { ok: false, values: null, missingKeys, invalidKeys, configurationProblem, warnings };
    }

    return {
        ok: true,
        values: {
            stopServiceMinutes: Number(get('stop_service_minutes')),
            planningMarginPct:  Number(get('planning_margin_pct')),
            calendar: {
                workingWeekdays: new Set(split(get('plan_working_days')).map(Number)),
                nonWorkingDates: new Set(holidaysBlank ? [] : split(holidaysRaw!.trim())),
            },
            promiseRules: {
                minOperatingDays:             Number(get('service_min_operating_days')),
                maxOperatingDays:             Number(get('service_max_operating_days')),
                routeCutoffTime:              get('route_cutoff_time'),
                promiseResponseWindowMinutes: Number(get('promise_response_window_minutes')),
            },
            slotDurationMinutes: Number(get('slot_duration_minutes')),
            morningWindow:       { start: get('morning_window_start'), end: get('morning_window_end') },
            afternoonWindow:     { start: get('afternoon_window_start'), end: get('afternoon_window_end') },
            minOrdersPerRoute:   minOrdersBlank ? null : Number(minOrdersRaw!.trim()),
        },
        missingKeys,
        invalidKeys,
        configurationProblem: null,
        warnings,
    };
}

/** The same cross-key rules `PUT /settings/:key` enforces, plus the lunch break being a break. */
function findConfigurationProblem(raw: RawSettings, get: (key: string) => string): string | null {
    const known: Record<string, string> = {};
    for (const key of PLANNING_SETTING_KEYS) {
        if (!isBlank(raw[key])) known[key] = raw[key]!.trim();
    }
    const problem = validateSettingConfiguration(known);
    if (problem) return problem;

    if (minutesOfDay(get('morning_window_end')) > minutesOfDay(get('afternoon_window_start'))) {
        return 'morning_window_end must not be later than afternoon_window_start.';
    }
    return null;
}

/** Anything that can answer a setting by key (SettingsService); `''` is returned when it is absent. */
export interface SettingsReader {
    getString(key: string, fallback: string): Promise<string>;
}

export async function loadPlanningSettings(reader: SettingsReader): Promise<PlanningSettingsResult> {
    const raw: RawSettings = {};
    for (const key of PLANNING_SETTING_KEYS) raw[key] = await reader.getString(key, '');
    return parsePlanningSettings(raw);
}
