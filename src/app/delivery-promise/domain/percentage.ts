import { round1 } from '../../sla-report/domain/sla-metrics.js';

/**
 * Over the eligible ones, one decimal. 1999 of 2000 would round to 100.0 and it is shown as 99.9, so 100 always means
 * «none out of the window» (same rule as ES-54). With no eligible dispatch there is no rate: `null` is «Sin datos», not 0.
 */
export function percentage(numerator: number, denominator: number): number | null {
    if (denominator === 0) return null;
    const value = round1((numerator / denominator) * 100);
    return numerator < denominator && value === 100 ? 99.9 : value;
}
