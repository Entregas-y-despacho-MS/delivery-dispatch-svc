/**
 * The planning universe of a D-1 cutoff (ST-302.2, ES-302). Pure: no Nest, no SQL, no clock.
 *
 * It answers one question per dispatch of the provisional batches of the day: is it `eligible` (it counts in the
 * denominator of the coverage) or `excluded` (with a code and an explanation)? The rule is the one the cutoff itself
 * applies, `classifyStop`, so the snapshot and the reoptimization cannot disagree about who entered.
 *
 * A dispatch of a batch the cutoff cannot simulate (no sequence, no point on the map, no warehouse) is still
 * classified by its promise: it stays in the denominator and simply never gets confirmed.
 */
import { classifyStop, entersCutoff } from '../../route-cutoff/domain/cutoff-eligibility.js';
import type { CutoffEligibility } from '../../route-cutoff/domain/cutoff-types.js';
import { cutoffExclusion, type CutoffExclusion, type CutoffExclusionCode } from './cutoff-exclusion.js';

/** One dispatch of a provisional batch of the day, as the snapshot reads it (raw facts, nothing decided). */
export interface UniverseDispatchRead {
    dispatchId: number;
    routeBatchId: number;
    /** `route_batches.version` of the batch at the moment of the read. */
    routeVersion: number;
    dispatchTypeId: number;
    /** `delivery`, `supplier_pickup`, `warehouse_return_pickup`. */
    dispatchType: string;
    /** `dispatch_statuses.name` as stored. */
    status: string;
    deliveryZoneId: number | null;
    originWarehouseId: number | null;
    scheduledWindowStart: Date | null;
    promiseNotifiedAt: Date | null;
    promiseFirmedAt: Date | null;
}

export interface UniverseEntry {
    dispatchId: number;
    universeStatus: 'eligible' | 'excluded';
    exclusionCode: CutoffExclusionCode | null;
    exclusionDetail: string | null;
    routeBatchId: number;
    routeVersion: number;
    dispatchTypeId: number;
    deliveryZoneId: number | null;
    originWarehouseId: number | null;
    scheduledWindowStart: Date | null;
}

/** The cutoff reads only these three statuses of a stop; any other counts as never approved (same rule as `CutoffBatchesRepository`). */
export function normalizeCutoffStatus(status: string): 'scheduled' | 'pickup_scheduled' | 'in_planning' {
    return status === 'scheduled' || status === 'pickup_scheduled' ? status : 'in_planning';
}

const EXCLUSION_BY_ELIGIBILITY: Partial<Record<CutoffEligibility, CutoffExclusionCode>> = {
    window_open: 'cutoff_window_open',
    no_promise: 'cutoff_no_promise',
};

export function buildCutoffUniverse(reads: readonly UniverseDispatchRead[], now: Date, windowMinutes: number): UniverseEntry[] {
    return [...reads]
        .sort((a, b) => a.dispatchId - b.dispatchId)
        .map((read) => {
            const eligibility = classifyStop(
                {
                    promiseNotifiedAt: read.promiseNotifiedAt,
                    promiseFirmedAt: read.promiseFirmedAt,
                    dispatch: { status: normalizeCutoffStatus(read.status), dispatchType: read.dispatchType },
                },
                now,
                windowMinutes,
            );
            let exclusion: CutoffExclusion | null = null;
            if (!entersCutoff(eligibility)) {
                const code = EXCLUSION_BY_ELIGIBILITY[eligibility];
                // A new eligibility value without a code must stop here: it would be counted as eligible by mistake.
                if (code === undefined) throw new Error(`The cutoff eligibility '${eligibility}' has no exclusion code.`);
                exclusion = cutoffExclusion(code);
            }
            return {
                dispatchId: read.dispatchId,
                universeStatus: exclusion === null ? 'eligible' : 'excluded',
                exclusionCode: exclusion?.code ?? null,
                exclusionDetail: exclusion?.detail ?? null,
                routeBatchId: read.routeBatchId,
                routeVersion: read.routeVersion,
                dispatchTypeId: read.dispatchTypeId,
                deliveryZoneId: read.deliveryZoneId,
                originWarehouseId: read.originWarehouseId,
                scheduledWindowStart: read.scheduledWindowStart,
            } satisfies UniverseEntry;
        });
}

export interface UniverseCounts {
    eligible: number;
    excluded: number;
    byExclusionCode: Partial<Record<CutoffExclusionCode, number>>;
}

export function countUniverse(entries: readonly UniverseEntry[]): UniverseCounts {
    const counts: UniverseCounts = { eligible: 0, excluded: 0, byExclusionCode: {} };
    for (const entry of entries) {
        if (entry.universeStatus === 'eligible') {
            counts.eligible += 1;
            continue;
        }
        counts.excluded += 1;
        const code = entry.exclusionCode!;
        counts.byExclusionCode[code] = (counts.byExclusionCode[code] ?? 0) + 1;
    }
    return counts;
}
