import { describe, expect, it } from 'vitest';
import { partitionStops } from '../../route-cutoff/domain/cutoff-eligibility.js';
import type { CutoffStop } from '../../route-cutoff/domain/cutoff-types.js';
import {
    CUTOFF_NOW,
    NOTIFIED_LONG_AGO,
    NOTIFIED_TODAY,
    stop,
    type StopOptions,
} from '../../route-cutoff/domain/cutoff-fixtures.helper-spec.js';
import {
    CUTOFF_EXCLUSION_CODES,
    CUTOFF_EXCLUSION_EXPLANATIONS,
    EXCLUSION_CODE_PATTERN,
    cutoffExclusion,
} from './cutoff-exclusion.js';
import {
    buildCutoffUniverse,
    countUniverse,
    normalizeCutoffStatus,
    type UniverseDispatchRead,
} from './cutoff-universe.js';

const WINDOW = 720;

/** The snapshot reads facts, not a `CutoffStop`: rebuild them from the same fixture so both rules see the same stop. */
function readOf(source: CutoffStop, extra: Partial<UniverseDispatchRead> = {}): UniverseDispatchRead {
    return {
        dispatchId: source.dispatch.dispatchId,
        routeBatchId: 50,
        routeVersion: 4,
        dispatchTypeId: 1,
        dispatchType: source.dispatch.dispatchType,
        status: source.dispatch.status,
        deliveryZoneId: 1,
        originWarehouseId: 1,
        scheduledWindowStart: source.window?.start ?? null,
        promiseNotifiedAt: source.promiseNotifiedAt,
        promiseFirmedAt: source.promiseFirmedAt,
        ...extra,
    };
}

describe('exclusion codes', () => {
    it('explains every code and every code fits the database format', () => {
        for (const code of CUTOFF_EXCLUSION_CODES) {
            expect(code).toMatch(EXCLUSION_CODE_PATTERN);
            expect(CUTOFF_EXCLUSION_EXPLANATIONS[code].trim().length).toBeGreaterThan(0);
            expect(cutoffExclusion(code)).toEqual({ code, detail: CUTOFF_EXCLUSION_EXPLANATIONS[code] });
        }
    });
});

describe('buildCutoffUniverse', () => {
    it('marks a firm promise, a closed window and a pickup as eligible with no exclusion', () => {
        const entries = buildCutoffUniverse(
            [
                readOf(stop(1, { firmed: true })),
                readOf(stop(2)),
                readOf(stop(3, { status: 'pickup_scheduled' })),
            ],
            CUTOFF_NOW,
            WINDOW,
        );
        expect(entries.map((entry) => entry.universeStatus)).toEqual(['eligible', 'eligible', 'eligible']);
        for (const entry of entries) {
            expect(entry.exclusionCode).toBeNull();
            expect(entry.exclusionDetail).toBeNull();
        }
    });

    it('excludes an open window with its code and its explanation', () => {
        const [entry] = buildCutoffUniverse([readOf(stop(1, { notifiedAt: NOTIFIED_TODAY }))], CUTOFF_NOW, WINDOW);
        expect(entry.universeStatus).toBe('excluded');
        expect(entry.exclusionCode).toBe('cutoff_window_open');
        expect(entry.exclusionDetail).toBe(CUTOFF_EXCLUSION_EXPLANATIONS.cutoff_window_open);
    });

    it('excludes an order that was never approved', () => {
        const [entry] = buildCutoffUniverse([readOf(stop(1, { status: 'in_planning' }))], CUTOFF_NOW, WINDOW);
        expect(entry.universeStatus).toBe('excluded');
        expect(entry.exclusionCode).toBe('cutoff_no_promise');
    });

    it('treats a status the cutoff does not read as never approved', () => {
        expect(normalizeCutoffStatus('assigned')).toBe('in_planning');
        expect(normalizeCutoffStatus('scheduled')).toBe('scheduled');
        expect(normalizeCutoffStatus('pickup_scheduled')).toBe('pickup_scheduled');
        const [entry] = buildCutoffUniverse([{ ...readOf(stop(1)), status: 'assigned' }], CUTOFF_NOW, WINDOW);
        expect(entry.exclusionCode).toBe('cutoff_no_promise');
    });

    it('keeps the facts of the moment of the cutoff and sorts by dispatch', () => {
        const entries = buildCutoffUniverse(
            [
                readOf(stop(9), { routeBatchId: 70, routeVersion: 8, deliveryZoneId: null, originWarehouseId: null, scheduledWindowStart: null }),
                readOf(stop(2), { routeBatchId: 60, routeVersion: 3, dispatchTypeId: 2 }),
            ],
            CUTOFF_NOW,
            WINDOW,
        );
        expect(entries.map((entry) => entry.dispatchId)).toEqual([2, 9]);
        expect(entries[0]).toMatchObject({ routeBatchId: 60, routeVersion: 3, dispatchTypeId: 2 });
        expect(entries[1]).toMatchObject({ routeBatchId: 70, routeVersion: 8, deliveryZoneId: null, originWarehouseId: null, scheduledWindowStart: null });
    });

    it('does not depend on the order of the read, so the same read gives the same universe', () => {
        const reads = [readOf(stop(3)), readOf(stop(1, { firmed: true })), readOf(stop(2, { status: 'in_planning' }))];
        expect(buildCutoffUniverse([...reads].reverse(), CUTOFF_NOW, WINDOW)).toEqual(buildCutoffUniverse(reads, CUTOFF_NOW, WINDOW));
    });

    it('does not change the input', () => {
        const reads = [readOf(stop(2)), readOf(stop(1))];
        const copy = reads.map((read) => ({ ...read }));
        buildCutoffUniverse(reads, CUTOFF_NOW, WINDOW);
        expect(reads).toEqual(copy);
    });

    it('returns an empty universe for an empty read', () => {
        expect(buildCutoffUniverse([], CUTOFF_NOW, WINDOW)).toEqual([]);
    });
});

describe('the snapshot and the cutoff agree on who enters', () => {
    const statuses: NonNullable<StopOptions['status']>[] = ['in_planning', 'scheduled', 'pickup_scheduled'];
    const notices = [null, NOTIFIED_LONG_AGO, NOTIFIED_TODAY];
    const combinations: StopOptions[] = statuses.flatMap((status) =>
        notices.flatMap((notifiedAt) => [true, false].map((firmed) => ({ status, notifiedAt, firmed }))),
    );

    it('gives the same eligible, open and without-promise split as partitionStops for every combination', () => {
        const stops = combinations.map((options, index) => stop(index + 1, options));
        const part = partitionStops(stops, CUTOFF_NOW, WINDOW);
        const entries = buildCutoffUniverse(stops.map((source) => readOf(source)), CUTOFF_NOW, WINDOW);

        const ids = (code: string | null) =>
            entries.filter((entry) => entry.exclusionCode === code).map((entry) => entry.dispatchId);
        const sorted = (list: CutoffStop[]) => list.map((item) => item.dispatch.dispatchId).sort((a, b) => a - b);

        expect(ids(null)).toEqual(sorted(part.eligible));
        expect(ids('cutoff_window_open')).toEqual(sorted(part.open));
        expect(ids('cutoff_no_promise')).toEqual(sorted(part.withoutPromise));
        expect(entries).toHaveLength(stops.length);
    });
});

describe('countUniverse', () => {
    it('counts eligible and excluded dispatches and groups the exclusions by code', () => {
        const entries = buildCutoffUniverse(
            [
                readOf(stop(1, { firmed: true })),
                readOf(stop(2)),
                readOf(stop(3, { notifiedAt: NOTIFIED_TODAY })),
                readOf(stop(4, { notifiedAt: NOTIFIED_TODAY })),
                readOf(stop(5, { status: 'in_planning' })),
            ],
            CUTOFF_NOW,
            WINDOW,
        );
        expect(countUniverse(entries)).toEqual({
            eligible: 2,
            excluded: 3,
            byExclusionCode: { cutoff_window_open: 2, cutoff_no_promise: 1 },
        });
    });

    it('is zero for an empty universe', () => {
        expect(countUniverse([])).toEqual({ eligible: 0, excluded: 0, byExclusionCode: {} });
    });
});
