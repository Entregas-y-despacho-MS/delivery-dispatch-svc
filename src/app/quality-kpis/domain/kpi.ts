import { percentage } from '../../delivery-promise/domain/percentage.js';

/**
 * The shape of every indicator of Dashboard 4 (ST-300.1, ES-300): the formula, its numerator, denominator and `n` travel
 * with the value. A value that cannot be told is `available: false` with the cause (N/D); a value with nothing to measure
 * is `available: true` and `value: null` («Sin datos»). It is never a made-up 0.
 */
export enum KpiUnit {
    PERCENT = 'percent',
    MINUTES = 'minutes',
    SCORE   = 'score',
}

export const KpiUnavailableReason = {
    ATTEMPT_COVERAGE_INCOMPLETE:    'attempt_coverage_incomplete',
    INVESTIGATION_TIMESTAMP_MISSING: 'investigation_timestamp_missing',
    RATING_NOT_AUTHORIZED:          'rating_not_authorized',
    RESPONSE_OPPORTUNITY_NOT_RECORDED: 'response_opportunity_not_recorded',
} as const;

export interface QualityKpi {
    code: string;
    /** The rule in words, as the screen shows it. */
    formula: string;
    unit: KpiUnit;
    numerator: number | null;
    denominator: number | null;
    /** Sample size behind `value`. */
    n: number;
    value: number | null;
    available: boolean;
    /** Why `value` is N/D; null when available. */
    reason: string | null;
    /** Date the cohort is placed by (`promise_window_end`, `closed_at`...). */
    dateBasis: string;
}

interface KpiBase {
    code: string;
    formula: string;
    dateBasis: string;
    /** When set, the value is N/D for this cause; the counts are still shown. */
    unavailableReason?: string | null;
}

/** A rate: numerator / denominator × 100, one decimal. `n` is the denominator. */
export function rateKpi(spec: KpiBase & { numerator: number; denominator: number }): QualityKpi {
    const reason = spec.unavailableReason ?? null;
    return {
        code: spec.code, formula: spec.formula, unit: KpiUnit.PERCENT, numerator: spec.numerator, denominator: spec.denominator, n: spec.denominator,
        value: reason ? null : percentage(spec.numerator, spec.denominator), available: reason === null, reason, dateBasis: spec.dateBasis,
    };
}

/** An indicator with no numerator or denominator that cannot be told: N/D with its cause, `n` = 0. */
export function unavailableKpi(spec: KpiBase & { unit: KpiUnit; reason: string }): QualityKpi {
    return {
        code: spec.code, formula: spec.formula, unit: spec.unit, numerator: null, denominator: null, n: 0,
        value: null, available: false, reason: spec.reason, dateBasis: spec.dateBasis,
    };
}

export function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
