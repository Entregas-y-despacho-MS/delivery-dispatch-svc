/**
 * Coverage at the cutoff (ST-302.2, ES-302, rule 5 of the HU). Pure.
 *
 * The denominator is the dispatches `eligible` in the cutoff itself, never today's statuses: the same cutoff gives the
 * same denominator whatever the route does afterwards. The numerator is the eligible ones that were later confirmed
 * (second approval). A confirmed dispatch that was not in the universe never enters the numerator.
 */
export interface CutoffRef {
    id: number;
    cutoffAt: Date;
    triggerType: 'scheduled' | 'manual';
}

/**
 * The official cutoff of a day is its first scheduled one; manual runs and later scheduled ones are listed but never
 * replace it. `null` when the day has only manual runs (or none): the coverage is then unknown, not guessed.
 */
export function pickOfficialCutoff<T extends CutoffRef>(cutoffs: readonly T[]): T | null {
    const scheduled = cutoffs.filter((cutoff) => cutoff.triggerType === 'scheduled');
    if (scheduled.length === 0) return null;
    return [...scheduled].sort((a, b) => a.cutoffAt.getTime() - b.cutoffAt.getTime() || a.id - b.id)[0];
}

export interface CoverageItem {
    dispatchId: number;
    universeStatus: 'eligible' | 'excluded';
    exclusionCode: string | null;
    confirmed: boolean;
}

export interface CoverageResult {
    eligible: number;
    confirmed: number;
    /** Eligible and not confirmed yet. */
    pending: number;
    /** `confirmed / eligible` in percent with two decimals; `null` with no eligible dispatch (there is nothing to cover). */
    coveragePct: number | null;
    excludedTotal: number;
    excludedByCode: Array<{ code: string; count: number }>;
}

export function computeCoverage(items: readonly CoverageItem[]): CoverageResult {
    let eligible = 0;
    let confirmed = 0;
    let excludedTotal = 0;
    const byCode = new Map<string, number>();
    for (const item of items) {
        if (item.universeStatus === 'eligible') {
            eligible += 1;
            if (item.confirmed) confirmed += 1;
            continue;
        }
        excludedTotal += 1;
        const code = item.exclusionCode ?? 'unknown';
        byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    return {
        eligible,
        confirmed,
        pending: eligible - confirmed,
        coveragePct: eligible === 0 ? null : Math.round((confirmed / eligible) * 10000) / 100,
        excludedTotal,
        excludedByCode: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    };
}
