/**
 * What goes into a route manifest and in which state (ST-302.2, ES-302). Pure: no Nest, no SQL.
 *
 * A `confirmed` manifest freezes the route as the coordinator approved it: every stop is `planned`. A `started` or
 * `revised` one separates the stops that leave (`departing`) from the ones held back (`excluded`, with its code).
 */
import type { RouteManifestKind } from '../entities/route-manifest.entity.js';
import type { RouteManifestStopState } from '../entities/route-manifest-stop.entity.js';

/** A stop held back by a failed package check (cotejo) when the route leaves. */
export const COTEJO_FAILED_EXCLUSION_CODE = 'cotejo_failed';

export interface ManifestSourceStop {
    dispatchId: number;
    dispatchTypeId: number;
    sequenceOrder: number | null;
}

export interface ManifestStopRow {
    dispatchId: number;
    dispatchTypeId: number;
    sequenceOrder: number | null;
    stopState: RouteManifestStopState;
    exclusionCode: string | null;
}

export function buildManifestStops(
    kind: RouteManifestKind,
    stops: readonly ManifestSourceStop[],
    excludedDispatchIds: readonly number[],
): ManifestStopRow[] {
    // Nothing is held back before the route leaves, so a `confirmed` manifest takes no exclusions: passing them is a bug of the caller.
    if (kind === 'confirmed' && excludedDispatchIds.length > 0) {
        throw new Error('A confirmed manifest has no excluded stops.');
    }
    const excluded = new Set(excludedDispatchIds);
    const known = new Set(stops.map((stop) => stop.dispatchId));
    const unknown = excludedDispatchIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
        throw new Error(`Dispatches ${unknown.join(', ')} are excluded but are not stops of the route.`);
    }
    return [...stops]
        .sort((a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER) || a.dispatchId - b.dispatchId)
        .map((stop) => {
            const isExcluded = excluded.has(stop.dispatchId);
            return {
                dispatchId: stop.dispatchId,
                dispatchTypeId: stop.dispatchTypeId,
                sequenceOrder: stop.sequenceOrder,
                stopState: kind === 'confirmed' ? 'planned' : isExcluded ? 'excluded' : 'departing',
                exclusionCode: isExcluded ? COTEJO_FAILED_EXCLUSION_CODE : null,
            };
        });
}
